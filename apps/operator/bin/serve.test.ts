/**
 * Unit tests for the headless `serve` helpers (SP1 C6 —
 * operator-core-headless-serve-2026-06-04).
 *
 * These exercise the pure/FS helpers WITHOUT booting a server: the module is
 * imported after `HOME` is pointed at a temp dir, so its homedir()-derived
 * path constants resolve under the temp dir (and never touch the real
 * ~/.papercusp). The entry guard in serve.ts keeps `main()` from running on
 * import. A full-boot integration test requires embedded-pg on an isolated
 * DB + alternate ports and runs under the desktop/CI (see the plan's Testing
 * section) — it is intentionally NOT here, because runBootstrap() starts
 * background tickers that must never touch the shared/native DB.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let tmpHome: string;
let origHome: string | undefined;
let origPapercuspHome: string | undefined;
let serve: typeof import("./serve");

const pcDir = () => join(tmpHome, ".papercusp");
const operatorJson = () => join(pcDir(), "operator.json");
const tokenFile = () => join(pcDir(), "superuser-token");
const lockFile = () => join(pcDir(), "operator.lock");
const serveSrc = readFileSync(join(__dirname, "serve.ts"), "utf8");

it('qualifies packaged tool imports before any singleton or Postgres boot', () => {
  const main = serveSrc.slice(serveSrc.indexOf('async function main():'));
  const probe = main.indexOf('argv[0] === "--verify-boot-imports"');
  expect(probe).toBeGreaterThan(-1);
  const branch = main.slice(probe, main.indexOf('\n  }', probe));
  expect(branch).toContain('await import("@papercusp/operator-core/lib/agent-tools/index")');
  expect(branch).toContain('PAPERCUSP_BOOT_IMPORTS_OK');
  expect(branch).toContain('process.exit(0)');
  expect(main.indexOf('pg = await ensurePostgres()')).toBeGreaterThan(probe);
  expect(main.indexOf('if (!acquireColdStartLock())')).toBeGreaterThan(probe);
});
const repoRoot = join(__dirname, "../../..");
it('reports prompt dispositions through the early verification seam before runtime effects', () => {
  const main = serveSrc.slice(serveSrc.indexOf('async function main():'));
  const probe = main.indexOf('argv[0] === "--verify-role-prompts"');
  expect(probe).toBeGreaterThan(-1);
  const branch = main.slice(probe, main.indexOf('\n  }', probe));
  expect(branch).toContain('JSON.stringify(verifyRolePromptAssets())');
  expect(branch).toContain('PAPERCUSP_ROLE_PROMPT_ASSETS ');
  expect(branch).toContain('process.exit(0)');
  expect(main.indexOf('pg = await ensurePostgres()')).toBeGreaterThan(probe);
  expect(main.indexOf('if (!acquireColdStartLock())')).toBeGreaterThan(probe);
});
const tsx = join(repoRoot, "node_modules/.bin/tsx");

beforeAll(async () => {
  origHome = process.env.HOME;
  origPapercuspHome = process.env.PAPERCUSP_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "serve-test-"));
  // os.homedir() honours $HOME on POSIX, so the module's path constants bind
  // to tmpHome at import. Restore the real HOME afterwards — the constants are
  // already captured, so the rest of the process is unaffected.
  process.env.HOME = tmpHome;
  // EI-13917: PAPERCUSP_DIR now honors PAPERCUSP_HOME BEFORE homedir() — clear
  // it here too, or the module binds its path constants to whatever
  // PAPERCUSP_HOME the CALLING process happens to have exported (e.g. this
  // very psu/fleet session's own per-workspace state dir) instead of tmpHome.
  delete process.env.PAPERCUSP_HOME;
  serve = await import("./serve");
  process.env.HOME = origHome;
  if (origPapercuspHome !== undefined) process.env.PAPERCUSP_HOME = origPapercuspHome;
});


describe("vm-release boot ordering (D-043 / P-050)", () => {
  it("installs the runtime flag store before any other import graph can read a flag", () => {
    const flagStore = serveSrc.indexOf('import "./boot-flag-store";');
    const firstHostImport = serveSrc.search(/import\s*\{[^}]*fileURLToPath[^}]*\}\s*from\s*["']node:url["']/);
    expect(flagStore).toBeGreaterThan(-1);
    expect(firstHostImport).toBeGreaterThan(flagStore);
  });

  it("verifies the immutable manifest before --ensure reuse and the effective port after sticky resolution", () => {
    const policy = serveSrc.indexOf("await assertVmReleaseApplicationRuntime({");
    const ensureReuse = serveSrc.indexOf("if (ensure) {", policy);
    const sticky = serveSrc.indexOf("await resolveStickyPort", ensureReuse);
    const effectivePort = serveSrc.indexOf("assertVmReleaseRuntimePort(port", sticky);
    expect(policy).toBeGreaterThan(-1);
    expect(ensureReuse).toBeGreaterThan(policy);
    expect(sticky).toBeGreaterThan(ensureReuse);
    expect(effectivePort).toBeGreaterThan(sticky);
  });
});

describe("native startup history provenance", () => {
  it.each(['manual', 'login', 'boot', 'supervisor', 'upgrade', 'repair', 'unknown'])("accepts the bounded %s marker", trigger => {
    expect(serve.nativeStartupTrigger(['--ensure', `--startup-trigger=${trigger}`])).toBe(trigger);
  });

  it.each([
    [], ['--startup-trigger=secret /private/path'], ['--startup-trigger='],
    ['--startup-trigger=manual', '--startup-trigger=supervisor'],
    ['--startup-trigger=manual', '--startup-trigger=manual'], ['--startup-trigger', 'manual'],
  ].map(argv => ({ argv })))("keeps missing or ambiguous provenance unknown: $argv", ({ argv }) => {
    expect(serve.nativeStartupTrigger(argv)).toBe('unknown');
  });

  it("records only in the local backend's actual-listen callback after singleton reuse", () => {
    const main = serveSrc.slice(serveSrc.indexOf('async function main():'));
    const listen = main.indexOf('server = serve(');
    const write = main.indexOf('await recordNativeListeningStart(nativeStartupTrigger(argv), listenedAt, {');
    expect(main.indexOf('if (ensure) {')).toBeLessThan(listen);
    expect(write).toBeGreaterThan(listen);
    expect(main.slice(listen, write)).toContain('if (!hostedControlPlane && !REQUEST_ONLY_SIDECAR)');
    expect(main.slice(write, write + 600)).toContain('native startup history unavailable');
    expect(main).toContain('await waitForBootMigrationGate()');
    expect(main).toContain('await awaitMigrationsAppliedForRequestGate({ timeoutMs: Number.POSITIVE_INFINITY })');
  });

  it('retains the actual listen time across a delayed migration without writing early', async () => {
    let ready!: () => void;
    const migrations = new Promise<void>(resolve => { ready = resolve; });
    const recordStart = vi.fn(async () => {});
    const at = '2026-10-31T12:00:00.000Z';
    const pending = serve.recordNativeListeningStart('login', at, {
      waitForMigrations: () => migrations, recordStart,
    });
    try {
      await Promise.resolve();
      expect(recordStart).not.toHaveBeenCalled();
      ready();
      await pending;
      expect(recordStart).toHaveBeenCalledExactlyOnceWith('login', at);
    } finally { ready(); await pending; }
  });

  it('does not attempt audit persistence when migration readiness fails', async () => {
    const recordStart = vi.fn(async () => {});
    const failure = new Error('migration withheld');
    await expect(serve.recordNativeListeningStart('boot', '2026-10-31T12:00:00.000Z', {
      waitForMigrations: async () => { throw failure; }, recordStart,
    })).rejects.toBe(failure);
    expect(recordStart).not.toHaveBeenCalled();
  });
});

describe("embedded PG host credential continuity (EI-25943879774522083)", () => {
  const credentialsFile = () => join(pcDir(), "embedded-pg-credentials.json");

  afterEach(() => rmSync(credentialsFile(), { force: true }));

  it("keeps an unkeyed developer cluster on the existing default path", () => {
    expect(serve.embeddedPgCredentialsFile({})).toBeUndefined();
  });

  it("selects generated credentials for a first explicit opt-in", () => {
    expect(serve.embeddedPgCredentialsFile({ PAPERCUSP_PG_HOST_CREDENTIALS: "1" }))
      .toBe(credentialsFile());
  });

  it("selects generated credentials on the first vm-release boot", () => {
    expect(serve.embeddedPgCredentialsFile({ PAPERCUSP_DISTRIBUTION_PROFILE: "vm-release" }))
      .toBe(credentialsFile());
  });

  it("reuses stored credentials after the opt-in flag is absent on restart", () => {
    mkdirSync(pcDir(), { recursive: true });
    // Selection must be sticky; the embedded server separately validates the
    // stored secrets and refuses corrupt files instead of regenerating them.
    writeFileSync(credentialsFile(), "{}");
    expect(serve.embeddedPgCredentialsFile({})).toBe(credentialsFile());
  });

  it("cannot fall back to public defaults by unsetting the flag on a keyed cluster", () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(credentialsFile(), "{}");
    expect(serve.embeddedPgCredentialsFile({ PAPERCUSP_PG_HOST_CREDENTIALS: "0" }))
      .toBe(credentialsFile());
  });
});

describe("bind host (open-source-release P-010)", () => {
  it("never reads the generic HOSTNAME var for the listen address", () => {
    expect(serveSrc).not.toMatch(/process\.env\.HOSTNAME/);
    expect(serveSrc).toContain("const hostname = resolveBindHost();");
  });

  it("validates the remote-auth policy before any listen", () => {
    const resolved = serveSrc.indexOf("const hostname = resolveBindHost();");
    const policy = serveSrc.indexOf("assertRemoteAuthReady(hostname);", resolved);
    const listen = serveSrc.indexOf("serve({ fetch: requestHandler, port, hostname }");
    expect(resolved).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(resolved);
    expect(listen).toBeGreaterThan(policy);
  });
});

describe("hosted control-plane serve profile (D-051 / P-037)", () => {
  it("is selected only by the explicit distribution profile", () => {
    expect(
      serve.isHostedControlPlaneServeProfile({
        PAPERCUSP_DISTRIBUTION_PROFILE: "hosted-control-plane",
      }),
    ).toBe(true);
    expect(
      serve.isHostedControlPlaneServeProfile({
        PAPERCUSP_DISTRIBUTION_PROFILE: "vm-release",
      }),
    ).toBe(false);
    expect(serve.isHostedControlPlaneServeProfile({})).toBe(false);
  });

  it("keeps the hosted and local boot graphs in mutually exclusive branches", () => {
    const selection = serveSrc.indexOf("if (hostedControlPlane)");
    const hostedHandler = serveSrc.indexOf(
      'import("./hosted-handler")',
      selection,
    );
    const localBranch = serveSrc.indexOf("} else {", hostedHandler);
    const bootstrap = serveSrc.indexOf(
      'import("./host-bootstrap")',
      localBranch,
    );
    const localHandler = serveSrc.indexOf(
      'import("./host-handler")',
      localBranch,
    );
    const serveCall = serveSrc.indexOf(
      "server = serve({ fetch: requestHandler",
      localHandler,
    );

    expect(selection).toBeGreaterThan(-1);
    expect(hostedHandler).toBeGreaterThan(selection);
    expect(localBranch).toBeGreaterThan(hostedHandler);
    expect(bootstrap).toBeGreaterThan(localBranch);
    expect(localHandler).toBeGreaterThan(localBranch);
    expect(serveCall).toBeGreaterThan(localHandler);
  });
});

describe("request-only sidecar identity/discovery guard (P-008)", () => {
  it("classifies env id, explicit load-only, and request-only markers consistently", () => {
    expect(serve.isRequestOnlySidecar({}, null)).toBe(false);
    expect(serve.isRequestOnlySidecar({}, "staging")).toBe(true);
    expect(serve.isRequestOnlySidecar({ PAPERCUSP_IDENTITY_MODE: "load-only" }, null)).toBe(true);
    expect(serve.isRequestOnlySidecar({ PAPERCUSP_REQUEST_ONLY: "1" }, null)).toBe(true);
    expect(serve.isRequestOnlySidecar({ PAPERCUSP_REQUEST_ONLY: "0" }, null)).toBe(false);
  });

  it("keeps the request-only predicate at every primary discovery cleanup/write site", () => {
    const code = serveSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect((code.match(/REQUEST_ONLY_SIDECAR/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(code).not.toContain("REQUEST_ONLY_SIDEcar");
  });
});

describe("side-effect-free help (EI-21546899007927487)", () => {
  it.each(["--help", "-h"])(
    "%s exits successfully without touching runtime state",
    (flag) => {
      const isolatedRoot = mkdtempSync(join(tmpdir(), "serve-help-"));
      const isolatedPapercuspHome = join(isolatedRoot, "papercusp-home");
      const env = {
        ...process.env,
        PAPERCUSP_HOME: isolatedPapercuspHome,
        // If help ever falls through, fail before a database can start. The
        // expected exit-0 + usage assertions below prove the early return won.
        PAPERCUSP_USE_EMBEDDED_PG: "0",
        HARNESS_ADMIN_DATABASE_URL: "",
        HARNESS_DATABASE_URL: "",
      };

      try {
        const result = spawnSync(tsx, [join(__dirname, "serve.ts"), flag], {
          cwd: repoRoot,
          env,
          encoding: "utf8",
          timeout: 60_000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Usage: papercusp serve [--ensure] [--ui]");
        expect(result.stderr).not.toContain(
          "PAPERCUSP_USE_EMBEDDED_PG=0 requires HARNESS_ADMIN_DATABASE_URL",
        );
        expect(existsSync(isolatedPapercuspHome)).toBe(false);
      } finally {
        rmSync(isolatedRoot, { recursive: true, force: true });
      }
    },
  );

  it("returns before every packaged sidecar, lock, database, migration, and bootstrap path", () => {
    const main = serveSrc.indexOf("async function main(): Promise<void>");
    const contentBootstrap = serveSrc.indexOf('if (argv[0] === "--content-bootstrap")', main);
    const help = serveSrc.indexOf("if (isServeHelpRequest(argv))", main);
    const parentWatch = serveSrc.indexOf("startSidecarParentDeathWatch();", main);
    const substrate = serveSrc.indexOf("runSubstrateSidecarServer();", main);
    const lock = serveSrc.indexOf("if (!acquireColdStartLock())", main);
    const postgres = serveSrc.indexOf("pg = await ensurePostgres();", main);
    const bootstrap = serveSrc.indexOf("runBootstrap();", main);

    expect(main).toBeGreaterThan(-1);
    expect(contentBootstrap).toBeGreaterThan(main);
    expect(help).toBeGreaterThan(main);
    for (const bootSideEffect of [parentWatch, substrate, lock, postgres, bootstrap]) {
      expect(bootSideEffect).toBeGreaterThan(contentBootstrap);
      expect(bootSideEffect).toBeGreaterThan(help);
    }
  });
});

afterAll(() => {
  process.env.HOME = origHome;
  if (origPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = origPapercuspHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("pidAlive", () => {
  it("is true for the current process", () => {
    expect(serve.pidAlive(process.pid)).toBe(true);
  });
  it("is false for a nonexistent pid", () => {
    expect(serve.pidAlive(2 ** 30)).toBe(false);
  });
  it("is false for 0 / negative", () => {
    expect(serve.pidAlive(0)).toBe(false);
    expect(serve.pidAlive(-1)).toBe(false);
  });
});

describe("isOrphanedFromParent (EI-8894)", () => {
  it("is false when the ppid is unchanged", () => {
    expect(serve.isOrphanedFromParent(100, 100)).toBe(false);
  });
  it("is true when the ppid changed (reparented — original parent gone)", () => {
    expect(serve.isOrphanedFromParent(100, 1)).toBe(true);
    expect(serve.isOrphanedFromParent(100, 42)).toBe(true);
  });
  it("is false when there was no original parent to compare against (0)", () => {
    expect(serve.isOrphanedFromParent(0, 1)).toBe(false);
  });
});

describe("startParentDeathWatch (EI-8894)", () => {
  const origDesktop = process.env.PAPERCUSP_DESKTOP;
  afterEach(() => {
    if (origDesktop === undefined) delete process.env.PAPERCUSP_DESKTOP;
    else process.env.PAPERCUSP_DESKTOP = origDesktop;
  });

  it("is a no-op outside desktop mode (PAPERCUSP_DESKTOP unset) — never fires the callback", () => {
    delete process.env.PAPERCUSP_DESKTOP;
    let fired = false;
    // No timer is armed at all in this mode; calling it must not throw and
    // must not schedule anything that could later fire.
    expect(() =>
      serve.startParentDeathWatch(() => {
        fired = true;
      }),
    ).not.toThrow();
    expect(fired).toBe(false);
  });

  it("honors the headless-rig opt-out (PAPERCUSP_PARENT_DEATH_WATCH=0) even in desktop mode", () => {
    // Headless rig frames set PAPERCUSP_DESKTOP=1 for production parity but
    // launch from a shell that exits right after spawn — without the opt-out
    // the watch kills the sidecar mid-boot (2026-07-16 local-matrix gate RED).
    process.env.PAPERCUSP_DESKTOP = "1";
    process.env.PAPERCUSP_PARENT_DEATH_WATCH = "0";
    try {
      let fired = false;
      expect(() =>
        serve.startParentDeathWatch(() => {
          fired = true;
        }),
      ).not.toThrow();
      expect(fired).toBe(false);
    } finally {
      delete process.env.PAPERCUSP_PARENT_DEATH_WATCH;
    }
  });
});

describe("parent-death watch cannot go blind (EI-19486216732882752)", () => {
  const origDesktop = process.env.PAPERCUSP_DESKTOP;
  const origDeclared = process.env.PAPERCUSP_DESKTOP_PARENT_PID;
  afterEach(() => {
    if (origDesktop === undefined) delete process.env.PAPERCUSP_DESKTOP;
    else process.env.PAPERCUSP_DESKTOP = origDesktop;
    if (origDeclared === undefined)
      delete process.env.PAPERCUSP_DESKTOP_PARENT_PID;
    else process.env.PAPERCUSP_DESKTOP_PARENT_PID = origDeclared;
    vi.useRealTimers();
  });

  describe("resolveExpectedParentPid", () => {
    it("prefers the pid the launcher DECLARED over any ppid observation", () => {
      expect(
        serve.resolveExpectedParentPid(
          { PAPERCUSP_DESKTOP_PARENT_PID: "4321" },
          99,
        ),
      ).toEqual({ pid: 4321, declaredByLauncher: true });
    });

    it("falls back to the module-load ppid when the launcher declared nothing (older packaged app, newer sidecar)", () => {
      expect(
        serve.resolveExpectedParentPid({}, 99),
      ).toEqual({ pid: 99, declaredByLauncher: false });
    });

    // A malformed handoff must degrade to the old reparent-only semantics, never
    // to a bogus pid we would then liveness-check against (pid 0 / negatives are
    // process-GROUP selectors to kill(2) — treating one as a parent is dangerous).
    it.each(["", "0", "-1", "not-a-pid", "12.5"])(
      "ignores a malformed declared pid %j and falls back undeclared",
      (raw) => {
        expect(
          serve.resolveExpectedParentPid(
            { PAPERCUSP_DESKTOP_PARENT_PID: raw },
            77,
          ),
        ).toEqual({ pid: 77, declaredByLauncher: false });
      },
    );
  });

  describe("startParentDeathWatch", () => {
    it("REGRESSION (the 3-core/18.4GB fire): fires IMMEDIATELY when the parent died before the watch armed", () => {
      // The exact shape measured 2026-08-08: the real Tauri parent (2238351) died
      // while the sidecar sat in the cold-start-lock contention loop, so by arm
      // time it had already been reparented to systemd --user (2026497). The old
      // code read process.ppid HERE, recorded 2026497 as "original", compared it
      // against itself forever, and never self-terminated.
      process.env.PAPERCUSP_DESKTOP = "1";
      let fired = 0;
      serve.startParentDeathWatch(() => void fired++, {
        expectedPpid: 2238351,
        declaredByLauncher: true,
        currentPpid: () => 2026497,
        parentAlive: () => false,
      });
      expect(fired).toBe(1);
    });

    it("records the parent-death decision durably before handing off SIGTERM", () => {
      process.env.PAPERCUSP_DESKTOP = "1";
      const logPath = join(tmpHome, "gateway-parent-death.log");
      const previousGatewayMode = process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE;
      const previousGatewayLog = process.env.PAPERCUSP_GATEWAY_LOG;
      process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE = "1";
      process.env.PAPERCUSP_GATEWAY_LOG = logPath;

      try {
        let fired = 0;
        serve.startParentDeathWatch(() => void fired++, {
          expectedPpid: 2238351,
          declaredByLauncher: true,
          currentPpid: () => 2026497,
          parentAlive: () => false,
        });

        expect(fired).toBe(1);
        const durable = readFileSync(logPath, "utf8");
        expect(durable).toContain("[serve-parent-watch ");
        expect(durable).toContain("desktop parent pid 2238351 is gone");
        expect(durable).toContain(
          "self-terminating instead of running orphaned",
        );
      } finally {
        if (previousGatewayMode === undefined)
          delete process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE;
        else process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE = previousGatewayMode;
        if (previousGatewayLog === undefined)
          delete process.env.PAPERCUSP_GATEWAY_LOG;
        else process.env.PAPERCUSP_GATEWAY_LOG = previousGatewayLog;
        rmSync(logPath, { force: true });
      }
    });

    it("with a DECLARED parent pid, catches a dead parent even when ppid NEVER changes", () => {
      // This is the case a ppid watch structurally cannot see, and the whole
      // reason the launcher handoff exists: same ppid at every read, parent gone.
      process.env.PAPERCUSP_DESKTOP = "1";
      let fired = 0;
      serve.startParentDeathWatch(() => void fired++, {
        expectedPpid: 2026497,
        declaredByLauncher: true,
        currentPpid: () => 2026497,
        parentAlive: () => false,
      });
      expect(fired).toBe(1);
    });

    it("WITHOUT a declared pid, keeps reparent-only semantics (documents why the handoff is required)", () => {
      // Deliberate control: on the fallback path the liveness check would be
      // self-referential — the recorded value may already BE the reparent target,
      // which is alive by definition — so it must NOT fire here. This asserts the
      // limitation rather than hiding it: it is what main.rs's env handoff buys.
      vi.useFakeTimers();
      process.env.PAPERCUSP_DESKTOP = "1";
      let fired = 0;
      serve.startParentDeathWatch(() => void fired++, {
        expectedPpid: 2026497,
        declaredByLauncher: false,
        currentPpid: () => 2026497,
        parentAlive: () => false,
      });
      expect(fired).toBe(0);
    });

    it("does not fire while the parent is alive and we have not been reparented", () => {
      vi.useFakeTimers();
      process.env.PAPERCUSP_DESKTOP = "1";
      let fired = 0;
      serve.startParentDeathWatch(() => void fired++, {
        expectedPpid: 1234,
        declaredByLauncher: true,
        currentPpid: () => 1234,
        parentAlive: () => true,
      });
      expect(fired).toBe(0);
      vi.advanceTimersByTime(30_000);
      expect(fired).toBe(0);
    });

    it("still fires on the INTERVAL when the parent dies after a healthy arm (EI-8894 behaviour preserved)", () => {
      vi.useFakeTimers();
      process.env.PAPERCUSP_DESKTOP = "1";
      let fired = 0;
      let ppid = 1234;
      serve.startParentDeathWatch(() => void fired++, {
        expectedPpid: 1234,
        declaredByLauncher: true,
        currentPpid: () => ppid,
        parentAlive: () => true,
      });
      expect(fired).toBe(0);
      ppid = 2026497; // parent hard-killed → reparented mid-run
      vi.advanceTimersByTime(5_000);
      expect(fired).toBe(1);
    });

    // ---- FALSIFIABILITY CONTROLS -------------------------------------------
    // CLAUDE.md "Proving a guard is falsifiable": the subject here is a MODULE we
    // import, so the correct tier is a deliberately-wrong implementation kept
    // PERMANENTLY in the test file — never an in-tree mutation. (`git-sync`
    // sweeps the whole working tree every few minutes and has already committed
    // one probe mutant, EI-19450431506682666; the `locks:acquire_resource`
    // mitigation does NOT actually pause the sweep, verified 2026-07-26.)
    //
    // The two tests below are a CALIBRATION PAIR: identical input, opposite
    // outcomes. Without the pair, a control that "fails to detect" proves
    // nothing — it would also fail to detect if the property itself were broken.

    /** The pre-fix semantics, reproduced exactly: reference ppid read AT ARM TIME. */
    function blindParentDeathWatchPreFix(
      onOrphaned: () => void,
      o: { currentPpid: () => number },
    ): void {
      const originalPpid = o.currentPpid(); // ← the bug, in one line
      if (originalPpid !== o.currentPpid()) onOrphaned();
    }

    it("CONTROL (wrong impl): the pre-fix watch is BLIND to the measured orphan — this is the fire", () => {
      let fired = 0;
      blindParentDeathWatchPreFix(() => void fired++, {
        currentPpid: () => 2026497, // already reparented; compares against itself
      });
      expect(fired).toBe(0);
    });

    it("CALIBRATION (real impl): the SAME input fires under the shipped watch", () => {
      process.env.PAPERCUSP_DESKTOP = "1";
      let fired = 0;
      serve.startParentDeathWatch(() => void fired++, {
        expectedPpid: 2026497,
        declaredByLauncher: true,
        currentPpid: () => 2026497,
        parentAlive: () => false,
      });
      expect(fired).toBe(1);
    });
    // ------------------------------------------------------------------------

    it("stays opted out for headless rigs even when the parent is provably dead", () => {
      process.env.PAPERCUSP_DESKTOP = "1";
      process.env.PAPERCUSP_PARENT_DEATH_WATCH = "0";
      try {
        let fired = 0;
        serve.startParentDeathWatch(() => void fired++, {
          expectedPpid: 2238351,
          declaredByLauncher: true,
          currentPpid: () => 2026497,
          parentAlive: () => false,
        });
        expect(fired).toBe(0);
      } finally {
        delete process.env.PAPERCUSP_PARENT_DEATH_WATCH;
      }
    });

    it("hands an orphaned packaged sidecar to its SIGTERM lifecycle handler", () => {
      process.env.PAPERCUSP_DESKTOP = "1";
      const signals: NodeJS.Signals[] = [];
      serve.startSidecarParentDeathWatch(
        {
          expectedPpid: 2238351,
          declaredByLauncher: true,
          currentPpid: () => 2026497,
          parentAlive: () => false,
        },
        (signal) => signals.push(signal),
      );
      expect(signals).toEqual(["SIGTERM"]);
    });

    describe("off-desktop sidecars (WI-6554700010011963: 16 orphaned sidecars held 99 GiB)", () => {
      const withoutDesktop = (fn: () => void) => {
        const prev = process.env.PAPERCUSP_DESKTOP;
        delete process.env.PAPERCUSP_DESKTOP;
        try { fn(); } finally {
          if (prev === undefined) delete process.env.PAPERCUSP_DESKTOP;
          else process.env.PAPERCUSP_DESKTOP = prev;
        }
      };

      it("REGRESSION: a sidecar launched by a non-desktop host self-terminates once its declared parent is dead", () => {
        // Measured shape: an LSP daemon launched by a superseded :3170 staging generation.
        // PAPERCUSP_DESKTOP was unset, PAPERCUSP_DESKTOP_PARENT_PID=3750613 was gone, and
        // the daemon had been reparented to systemd --user (4054). The old desktop-only gate
        // returned before arming, so it ran for 2.5 days.
        withoutDesktop(() => {
          const signals: NodeJS.Signals[] = [];
          serve.startSidecarParentDeathWatch(
            { expectedPpid: 3750613, declaredByLauncher: true, currentPpid: () => 4054, parentAlive: () => false, parentIdentity: () => null },
            (signal) => signals.push(signal),
          );
          expect(signals).toEqual(["SIGTERM"]);
        });
      });

      it("does NOT fire for a healthy cluster-pinned sidecar whose direct ppid is a worker, not the declared host", () => {
        // Live shape: declared parent 1516711 (host primary) is alive, and the direct parent is
        // worker 867346. The desktop ppid-equality test would wrongly fire here.
        withoutDesktop(() => {
          const signals: NodeJS.Signals[] = [];
          serve.startSidecarParentDeathWatch(
            { expectedPpid: 1516711, declaredByLauncher: true, currentPpid: () => 867346, parentAlive: () => true, parentIdentity: () => "777" },
            (signal) => signals.push(signal),
          );
          expect(signals).toEqual([]);
        });
      });

      it("treats a RECYCLED declared parent pid as dead (PIDs wrap about daily on the dev box)", () => {
        withoutDesktop(() => {
          const identities = ["1000", "2000"]; // arm-time start ticks, then a NEW process on the same pid
          const signals: NodeJS.Signals[] = [];
          serve.startSidecarParentDeathWatch(
            { expectedPpid: 3750613, declaredByLauncher: true, currentPpid: () => 4054, parentAlive: () => true, parentIdentity: () => identities.shift() ?? "2000" },
            (signal) => signals.push(signal),
          );
          expect(signals).toEqual(["SIGTERM"]);
        });
      });

      it("stays inert off-desktop when the launcher declared NO parent (no contract to enforce)", () => {
        withoutDesktop(() => {
          const signals: NodeJS.Signals[] = [];
          serve.startSidecarParentDeathWatch(
            { expectedPpid: 3750613, declaredByLauncher: false, currentPpid: () => 4054, parentAlive: () => false, parentIdentity: () => null },
            (signal) => signals.push(signal),
          );
          expect(signals).toEqual([]);
        });
      });

      it("keeps serve's OWN watch desktop-only: a hand-launched serve may outlive its shell", () => {
        withoutDesktop(() => {
          let fired = 0;
          serve.startParentDeathWatch(() => void fired++, {
            expectedPpid: 3750613, declaredByLauncher: true, currentPpid: () => 4054, parentAlive: () => false, parentIdentity: () => null,
          });
          expect(fired).toBe(0);
        });
      });
    });
  });
});

describe("writeJsonAtomic + readOperatorDiscovery", () => {
  afterEach(() => {
    rmSync(operatorJson(), { force: true });
  });

  it("round-trips discovery and writes owner-only perms (0600 file / 0700 dir)", async () => {
    const disc = {
      httpUrl: "http://127.0.0.1:3070",
      port: 3070,
      token: "super-secret-token",
      pid: process.pid,
      processIdentity: "linux:test-boot:12345",
      startedAt: Date.now(),
      version: "test",
      sha: "abc1234",
    };
    await serve.writeJsonAtomic(operatorJson(), disc);

    const read = serve.readOperatorDiscovery();
    expect(read).toMatchObject({
      httpUrl: disc.httpUrl,
      port: 3070,
      token: "super-secret-token",
      pid: process.pid,
      processIdentity: "linux:test-boot:12345",
      sha: "abc1234",
    });

    // Credential files must not be world/group readable.
    expect(statSync(operatorJson()).mode & 0o777).toBe(0o600);
    expect(statSync(pcDir()).mode & 0o777).toBe(0o700);
  });

  it("defaults sha and process identity to null for a legacy discovery record", async () => {
    const disc = {
      httpUrl: "http://127.0.0.1:3070",
      port: 3070,
      token: null,
      pid: process.pid,
      startedAt: Date.now(),
      version: "test",
      // no `sha` key at all — an older serve build's discovery record.
    };
    await serve.writeJsonAtomic(operatorJson(), disc);
    expect(serve.readOperatorDiscovery()?.sha).toBeNull();
    expect(serve.readOperatorDiscovery()?.processIdentity).toBeNull();
  });

  it("returns null when the file is missing", () => {
    expect(serve.readOperatorDiscovery()).toBeNull();
  });

  it("returns null when the file is corrupt", () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(operatorJson(), "not-json{");
    expect(serve.readOperatorDiscovery()).toBeNull();
  });
});

// EI-9002 recurrence guard: `serve --ensure` used to adopt ANY healthy
// operator on the port with zero build-identity check — installing a new
// version, relaunching, and getting a fully green boot while silently still
// running the pre-update process forever (proven live on the Windows VM,
// 2026-07-09: /api/health kept reporting the OLD sha+version from a process
// older than the install itself). buildIdentityMismatch is the decision
// function that now gates the reuse.
describe("buildIdentityMismatch (EI-9002)", () => {
  it("is false (reuse) when sha matches, even if version differs (e.g. dirty suffix drift)", () => {
    expect(
      serve.buildIdentityMismatch(
        { sha: "abc1234", version: "0.0.5" },
        { sha: "abc1234", version: "0.0.5-dirty" },
      ),
    ).toBe(false);
  });

  it("is true (mismatch) when both sides have a sha and they differ — the exact VM repro", () => {
    expect(
      serve.buildIdentityMismatch(
        { sha: "5fd810f-wi3407v2", version: "0.0.3" },
        { sha: "1a161ab-wi3407", version: "0.0.5" },
      ),
    ).toBe(true);
  });

  it("falls back to version comparison when either side has no sha", () => {
    expect(
      serve.buildIdentityMismatch(
        { sha: null, version: "0.0.3" },
        { sha: null, version: "0.0.5" },
      ),
    ).toBe(true);
    expect(
      serve.buildIdentityMismatch(
        { sha: "abc1234", version: "0.0.5" },
        { sha: null, version: "0.0.5" },
      ),
    ).toBe(false);
    expect(
      serve.buildIdentityMismatch(
        { sha: null, version: "0.0.5" },
        { sha: "abc1234", version: "0.0.5" },
      ),
    ).toBe(false);
  });

  it("is false when neither side resolved anything precise (no signal to force a restart on)", () => {
    expect(
      serve.buildIdentityMismatch(
        { sha: null, version: "unknown" },
        { sha: null, version: "unknown" },
      ),
    ).toBe(false);
  });
});

describe("runningOperatorIsNewer (WI-10005958)", () => {
  const newer = (running: string, mine: string) =>
    serve.runningOperatorIsNewer({ version: running }, { version: mine });

  it("a release launcher never replaces a running dev/rig compose", () => {
    // The measured case: installed 0.0.26 vs a rig sidecar reporting 0.0.0.
    expect(newer("0.0.0", "0.0.26")).toBe(true);
  });

  it("a dev launcher may always replace, whatever is running", () => {
    expect(newer("0.0.26", "0.0.0")).toBe(false);
    expect(newer("0.0.0", "0.0.0")).toBe(false);
  });

  it("release vs release: only a strictly greater running version is newer", () => {
    expect(newer("0.0.27", "0.0.26")).toBe(true);
    expect(newer("0.1.0", "0.0.99")).toBe(true);
    expect(newer("0.0.25", "0.0.26")).toBe(false);
    // Equal triples (a sha-only mismatch, or a pre-release suffix) keep the
    // EI-9002 replace behaviour.
    expect(newer("0.0.26", "0.0.26")).toBe(false);
    expect(newer("0.0.24-alpha", "0.0.24")).toBe(false);
  });

  it("an unparseable version is never treated as newer", () => {
    expect(newer("unknown", "0.0.26")).toBe(false);
  });
});

describe("terminateForeignOperator (EI-9002)", () => {
  it("is a no-op (never throws) for an already-dead pid", async () => {
    await expect(
      serve.terminateForeignOperator(2 ** 30, { graceMs: 100 }),
    ).resolves.toBe(true);
  });

  it("SIGTERMs a live process and returns once it exits", async () => {
    const { spawn } = await import("node:child_process");
    // A short-lived child that ignores nothing (default SIGTERM handling → exits).
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      {
        stdio: "ignore",
      },
    );
    // Poll until child is actually alive, rather than fixed timeout (WI-3220: fixes flakiness on slow systems).
    const deadline = Date.now() + 2000;
    while (!serve.pidAlive(child.pid!) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(serve.pidAlive(child.pid!)).toBe(true);
    await expect(
      serve.terminateForeignOperator(child.pid!, { graceMs: 2000 }),
    ).resolves.toBe(true);
    expect(serve.pidAlive(child.pid!)).toBe(false);
  });

  // The SIGKILL fallback used to fire-and-forget: it returned while the doomed
  // process was still alive, still holding its listening socket. The caller
  // then probed that port, found it taken, and moved the operator elsewhere.
  it("waits for the pid to be GONE after the SIGKILL fallback, not merely signalled", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"],
      { stdio: "ignore" },
    );
    // Poll until child is actually alive, rather than fixed timeout (WI-3220: fixes flakiness on slow systems).
    const deadline = Date.now() + 2000;
    while (!serve.pidAlive(child.pid!) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(serve.pidAlive(child.pid!)).toBe(true);
    await expect(
      serve.terminateForeignOperator(child.pid!, {
        graceMs: 300,
        killWaitMs: 3000,
      }),
    ).resolves.toBe(true);
    expect(serve.pidAlive(child.pid!)).toBe(false);
  });
});

describe("readToken", () => {
  afterEach(() => {
    rmSync(tokenFile(), { force: true });
  });

  it("reads and trims the superuser token", () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(tokenFile(), "  tok-123\n");
    expect(serve.readToken()).toBe("tok-123");
  });

  it("returns null when the token file is absent", () => {
    expect(serve.readToken()).toBeNull();
  });
});

describe("cold-start lock (singleton guard)", () => {
  afterEach(() => {
    rmSync(lockFile(), { force: true });
  });

  it("acquires, blocks a re-acquire while a live owner holds it, then frees on release", () => {
    expect(serve.acquireColdStartLock()).toBe(true); // we now own it
    expect(serve.acquireColdStartLock()).toBe(false); // held by a live pid (us)
    serve.releaseColdStartLock(); // owner === our pid → removed
    expect(serve.acquireColdStartLock()).toBe(true); // free again
    serve.releaseColdStartLock();
  });

  it("reclaims a stale lock whose owner is dead", () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(lockFile(), String(2 ** 30)); // a dead pid
    expect(serve.acquireColdStartLock()).toBe(true); // reclaimed
    serve.releaseColdStartLock();
  });

  it("creates ~/.papercusp if it does not exist yet (fresh machine)", () => {
    rmSync(pcDir(), { recursive: true, force: true });
    expect(serve.acquireColdStartLock()).toBe(true);
    serve.releaseColdStartLock();
  });
});

// WI-5393 recurrence guard: found live on gate run 122147 (host load 96+) —
// /proc/<pid>/cmdline can read EMPTY for a genuinely-alive process under
// heavy load (the same race isPortAccepting's own docstring already warns
// about), and the old reclaim check treated that ambiguous empty read as
// proof-of-not-serve, unlinking a still-valid lock and spawning a SECOND
// live serve.mjs beside the first. These inject `pidAlive`/`processCommandLine`
// to simulate the race deterministically — a real live process's cmdline
// can't be forced empty from a test.
describe("cold-start lock: ambiguous cmdline reads must fail CLOSED (WI-5393)", () => {
  afterEach(() => {
    rmSync(lockFile(), { force: true });
  });

  it("does NOT reclaim when the owner is alive but its cmdline read empty (load-induced /proc race)", () => {
    writeFileSync(lockFile(), "4242"); // an arbitrary "owner" pid
    expect(
      serve.acquireColdStartLock(false, {
        pidAlive: () => true,
        processCommandLine: () => "", // the load-induced empty /proc/<pid>/cmdline read
      }),
    ).toBe(false); // ambiguous, not proof of staleness — must not reclaim
    // The lock is untouched — still owned by the original (simulated) pid.
    expect(readFileSync(lockFile(), "utf8").trim()).toBe("4242");
  });

  it("still reclaims when the owner is alive but confirmed running an unrelated (non-serve) process (pid reuse)", () => {
    writeFileSync(lockFile(), "4242");
    expect(
      serve.acquireColdStartLock(false, {
        pidAlive: () => true,
        processCommandLine: () => "/usr/bin/some-unrelated-daemon --flag",
      }),
    ).toBe(true); // genuinely a different, non-serve process — safe to reclaim
    serve.releaseColdStartLock();
  });

  it("still refuses to reclaim when the owner is alive and its cmdline genuinely matches serve", () => {
    writeFileSync(lockFile(), "4242");
    expect(
      serve.acquireColdStartLock(false, {
        pidAlive: () => true,
        processCommandLine: () => "/some/path/bin/node /some/path/serve.mjs --ensure",
      }),
    ).toBe(false);
    expect(readFileSync(lockFile(), "utf8").trim()).toBe("4242");
  });

  it("still reclaims a lock whose owner pid is genuinely dead (unaffected by the new deps)", () => {
    writeFileSync(lockFile(), "4242");
    expect(
      serve.acquireColdStartLock(false, {
        pidAlive: () => false,
      }),
    ).toBe(true);
    serve.releaseColdStartLock();
  });
});

// WI-3287 recurrence guard: found live on the first real packaged-Linux
// env-switcher verify (2026-07-07) — a bundled env-sidecar sibling
// (env-operator-launcher.ts's `prod`/`staging`) re-execs this SAME serve.mjs
// under the SAME $HOME as the primary. Before PAPERCUSP_ENV_OPERATOR_ID
// scoping, its acquireColdStartLock() call collided with the primary's
// `operator.lock` — which the primary holds for its ENTIRE lifetime (only
// released on shutdown) — so every env-sidecar boot permanently failed with
// "another `serve` holds the cold-start lock" the instant the primary was up.
describe("cold-start lock scoping for env-operator siblings (PAPERCUSP_ENV_OPERATOR_ID)", () => {
  const stagingLock = () =>
    join(pcDir(), serve.lockFileNameForEnvId("staging"));
  const prodLock = () => join(pcDir(), serve.lockFileNameForEnvId("prod"));

  afterEach(() => {
    rmSync(lockFile(), { force: true });
    rmSync(stagingLock(), { force: true });
    rmSync(prodLock(), { force: true });
  });

  it("the primary (no id) and every env-sidecar id resolve to distinct, well-formed lock filenames", () => {
    expect(serve.lockFileNameForEnvId(null)).toBe("operator.lock");
    expect(serve.lockFileNameForEnvId("staging")).toBe(
      "operator.lock.env-staging",
    );
    expect(serve.lockFileNameForEnvId("prod")).toBe("operator.lock.env-prod");
    // No two distinct ids (including the primary's null) ever collide.
    const names = [null, "prod", "staging", "dev", "local"].map((id) =>
      serve.lockFileNameForEnvId(id),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("a sibling lock file can be acquired while the primary (unscoped) lock is held", () => {
    // Primary holds its own lock for its entire lifetime (released only on
    // shutdown) — the bug (found live 2026-07-07) was every sibling boot
    // colliding with THIS still-held lock via the same fixed path.
    expect(serve.acquireColdStartLock()).toBe(true);
    try {
      // Simulate a sibling's own acquire against its SCOPED path directly —
      // writeFileSync mirrors acquireColdStartLock's own `wx` (O_EXCL) create.
      expect(() =>
        writeFileSync(stagingLock(), "12345", { flag: "wx" }),
      ).not.toThrow();
      expect(statSync(stagingLock()).isFile()).toBe(true);
      // A second, different sibling id is likewise unaffected by both.
      expect(() =>
        writeFileSync(prodLock(), "12346", { flag: "wx" }),
      ).not.toThrow();
    } finally {
      serve.releaseColdStartLock();
    }
  });
});

describe("sweepOrphanPostgres", () => {
  const dataDir = () => join(tmpHome, "pg-data");
  const pidFile = () => join(dataDir(), "postmaster.pid");
  const logs: string[] = [];
  const logFn = (m: string) => logs.push(m);

  afterEach(() => {
    logs.length = 0;
    rmSync(dataDir(), { recursive: true, force: true });
  });

  it("is a no-op when there is no postmaster.pid", async () => {
    mkdirSync(dataDir(), { recursive: true });
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(logs).toEqual([]);
  });

  it("unlinks a stale postmaster.pid whose owner is dead", async () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(pidFile(), `${2 ** 30}\n/some/data/dir\n`);
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeUndefined();
    expect(logs.join("\n")).toMatch(/stale postmaster\.pid/);
  });

  it("unlinks a malformed (unparseable) postmaster.pid when nothing is listening on the recorded port (WI-3822)", async () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(pidFile(), "not-a-pid\n");
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeUndefined();
    expect(logs.join("\n")).toMatch(/malformed pid/);
    expect(logs.join("\n")).toMatch(/unparseable postmaster\.pid.*unlinking/s);
  });

  it("unlinks an all-NUL postmaster.pid (the exact ext4-delayed-allocation repro, WI-3822)", async () => {
    mkdirSync(dataDir(), { recursive: true });
    // 84 bytes of NUL — the observed on-disk shape after a qemu system_reset
    // caught the file mid-flush.
    writeFileSync(pidFile(), Buffer.alloc(84, 0));
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeUndefined();
    expect(logs.join("\n")).toMatch(/unparseable postmaster\.pid.*unlinking/s);
  });

  it("leaves a malformed postmaster.pid alone when the recorded port IS accepting (a live server may hold the dir, WI-3822)", async () => {
    mkdirSync(dataDir(), { recursive: true });
    const { createServer } = await import("node:net");
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    try {
      // Line 1 unparseable; line 4 (recorded port) IS accepting.
      writeFileSync(pidFile(), `not-a-pid\n${dataDir()}\n0\n${port}\n`);
      await serve.sweepOrphanPostgres(dataDir(), logFn);
      expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeDefined();
      expect(logs.join("\n")).toMatch(
        /pid unparseable but.*is accepting.*leaving.*alone/s,
      );
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("NEVER kills a live process that is not our postgres (only touches the lockfile)", async () => {
    mkdirSync(dataDir(), { recursive: true });
    // Our own (vitest) pid: alive, but cmdline is node/vitest — not postgres.
    // The recorded port (line 4) is a live listener, so a real server may hold
    // the dir → leave the file intact AND never signal the process (we must
    // still be alive afterwards, trivially true if the test completes).
    const { createServer } = await import("node:net");
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    try {
      writeFileSync(pidFile(), `${process.pid}\n${dataDir()}\n0\n${port}\n`);
      await serve.sweepOrphanPostgres(dataDir(), logFn);
      expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeDefined();
      expect(logs.join("\n")).toMatch(/is accepting.*leaving it alone/s);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("clears a stale lockfile whose pid was reused by a non-postgres process (WI-3360)", async () => {
    mkdirSync(dataDir(), { recursive: true });
    // Alive pid, cmdline not postgres, and the recorded port has NO listener —
    // i.e. the postgres that wrote this file is dead and its (low, WSL-recycled)
    // pid now belongs to something else. Leaving the file would FATAL the next
    // pg.start() with "lock file already exists" and crash-loop the operator, so
    // the stale lockfile must be cleared (the process itself is never touched).
    const { createServer } = await import("node:net");
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const deadPort = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r())); // free it → nothing accepts
    writeFileSync(pidFile(), `${process.pid}\n${dataDir()}\n0\n${deadPort}\n`);
    await serve.sweepOrphanPostgres(dataDir(), logFn);
    expect(statSync(pidFile(), { throwIfNoEntry: false })).toBeUndefined();
    expect(logs.join("\n")).toMatch(/not accepting.*unlinking/s);
  });
});

describe("detectRunningSharedPg (EI-14941)", () => {
  const dataDir = () => join(tmpHome, "shared-pg-data");
  const embeddedPgJson = () => join(pcDir(), "embedded-pg.json");
  const pidFile = () => join(dataDir(), "postmaster.pid");
  const logs: string[] = [];
  const logFn = (m: string) => logs.push(m);

  const adminUrlFor = (port: number) =>
    `postgresql://harness_admin:harness_admin_pwd@localhost:${port}/papercusp`;

  // Write the two on-disk records a live shared PG leaves: ~/.papercusp/embedded-pg.json
  // (owner operator pid + port + admin url) and <dataDir>/postmaster.pid (pid on line 1,
  // port on line 4 — PG's real format). `recordedPort` lets a test force a mismatch.
  const writeRecords = (ownerPid: number, port: number, recordedPort = port) => {
    mkdirSync(pcDir(), { recursive: true });
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(
      embeddedPgJson(),
      JSON.stringify({
        url: adminUrlFor(port),
        port,
        pid: ownerPid,
        startedAt: Date.now(),
      }),
    );
    writeFileSync(pidFile(), `${ownerPid}\n${dataDir()}\n0\n${recordedPort}\n`);
  };

  const withListener = async (
    fn: (port: number) => Promise<void>,
  ): Promise<void> => {
    const { createServer } = await import("node:net");
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  };

  afterEach(() => {
    logs.length = 0;
    rmSync(dataDir(), { recursive: true, force: true });
    rmSync(embeddedPgJson(), { force: true });
  });

  it("returns null when there is no embedded-pg.json (nothing to attach to)", async () => {
    mkdirSync(dataDir(), { recursive: true });
    expect(await serve.detectRunningSharedPg(dataDir(), logFn)).toBeNull();
  });

  it("ATTACHES to a live PG owned by a DIFFERENT, still-alive operator (the multi-tenant collision)", async () => {
    await withListener(async (port) => {
      // process.ppid is alive and != our pid → a live "foreign" owner.
      writeRecords(process.ppid, port);
      const got = await serve.detectRunningSharedPg(dataDir(), logFn);
      expect(got).toEqual({
        port,
        ownerPid: process.ppid,
        adminUrl: adminUrlFor(port),
      });
      expect(logs.join("\n")).toMatch(/will attach, not take over/);
    });
  });

  it("returns null when the recorded owner operator is DEAD (normal restart / orphan → sweep+start)", async () => {
    await withListener(async (port) => {
      writeRecords(2 ** 30, port); // dead owner pid
      expect(await serve.detectRunningSharedPg(dataDir(), logFn)).toBeNull();
    });
  });

  it("returns null when the owner is OUR OWN pid (not a foreign owner)", async () => {
    await withListener(async (port) => {
      writeRecords(process.pid, port);
      expect(await serve.detectRunningSharedPg(dataDir(), logFn)).toBeNull();
    });
  });

  it("returns null when nothing is accepting on the recorded port (PG not actually up)", async () => {
    const { createServer } = await import("node:net");
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const deadPort = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r())); // free it → nothing accepts
    writeRecords(process.ppid, deadPort);
    expect(await serve.detectRunningSharedPg(dataDir(), logFn)).toBeNull();
  });

  it("returns null when postmaster.pid's recorded port disagrees with embedded-pg.json (stale record) — even though a listener IS up", async () => {
    await withListener(async (port) => {
      // embedded-pg.json says `port` (and something accepts there), but the
      // on-disk postmaster.pid records a DIFFERENT port → not ground-truth ours.
      writeRecords(process.ppid, port, port + 1);
      expect(await serve.detectRunningSharedPg(dataDir(), logFn)).toBeNull();
    });
  });
});

describe("_shouldPublishGlobalPgDiscovery (WI-7462)", () => {
  // ~/.papercusp/embedded-pg.json is an advertisement to the WHOLE BOX. The
  // rule: never redirect the box away from an endpoint that is still serving
  // somebody. The 2026-08-03 outage (EI-19415174699106397) was a throwaway
  // verify-tauri-headless instance taking over this file and pointing the fleet
  // at a PG that died with it.
  const base = { existingPid: 4242, ourPort: 16012, ourPid: 999 };

  it("REFUSES to clobber a live foreign endpoint (the outage case)", () => {
    const v = serve._shouldPublishGlobalPgDiscovery({
      ...base,
      existingPort: 5432, // the box's canonical native PG
      foreignEndpointLive: true,
    });
    expect(v.publish).toBe(false);
    expect(v.reason).toMatch(/foreign endpoint :5432 is live/);
  });

  it("publishes when the prior advertisement no longer answers", () => {
    // The swept-orphan path: sweepOrphanPostgres() runs BEFORE our start, so by
    // publish time the old port is dead and taking over is correct.
    const v = serve._shouldPublishGlobalPgDiscovery({
      ...base,
      existingPort: 5432,
      foreignEndpointLive: false,
    });
    expect(v.publish).toBe(true);
  });

  it("publishes on a fresh box (no prior advertisement)", () => {
    expect(
      serve._shouldPublishGlobalPgDiscovery({
        ...base,
        existingPort: null,
        foreignEndpointLive: false,
      }).publish,
    ).toBe(true);
  });

  it("refreshes its own record when it already owns that endpoint", () => {
    // Same port as the one we just bound: writing updates pid/url/startedAt for
    // an endpoint we now own — it redirects nobody. Must NOT be refused, or a
    // normal desktop restart would stop advertising itself.
    const v = serve._shouldPublishGlobalPgDiscovery({
      ...base,
      existingPort: base.ourPort,
      foreignEndpointLive: true,
    });
    expect(v.publish).toBe(true);
    expect(v.reason).toMatch(/same endpoint/);
  });

  it("publishes over its own stale record from a prior identity", () => {
    const v = serve._shouldPublishGlobalPgDiscovery({
      existingPort: 5432,
      existingPid: 999,
      ourPort: 16012,
      ourPid: 999,
      foreignEndpointLive: true,
    });
    expect(v.publish).toBe(true);
    expect(v.reason).toMatch(/our own prior record/);
  });
});

describe("readPgDiscoveryRecord (WI-7462)", () => {
  it("returns null for a missing or malformed advertisement rather than throwing", () => {
    // A half-written discovery file must never crash the boot path.
    expect(serve.readPgDiscoveryRecord()).toBeNull();
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(join(pcDir(), "embedded-pg.json"), "{not json");
    expect(serve.readPgDiscoveryRecord()).toBeNull();
    writeFileSync(
      join(pcDir(), "embedded-pg.json"),
      JSON.stringify({ port: 5432, pid: 22998 }),
    );
    expect(serve.readPgDiscoveryRecord()).toEqual({ port: 5432, pid: 22998 });
    rmSync(join(pcDir(), "embedded-pg.json"), { force: true });
  });
});

describe("removeOwnedPgDiscoveryFile", () => {
  const discovery = () => join(pcDir(), "embedded-pg.json");

  afterEach(() => {
    rmSync(discovery(), { force: true });
  });

  it("removes the current process's advertisement on shutdown", () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(discovery(), JSON.stringify({ pid: 4242, port: 15084 }));

    expect(serve.removeOwnedPgDiscoveryFile(discovery(), 4242, 15084)).toBe(true);
    expect(statSync(discovery(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("leaves a newer process's advertisement intact", () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(discovery(), JSON.stringify({ pid: 5252, port: 16084 }));

    expect(serve.removeOwnedPgDiscoveryFile(discovery(), 4242, 15084)).toBe(false);
    expect(JSON.parse(readFileSync(discovery(), "utf8"))).toEqual({
      pid: 5252,
      port: 16084,
    });
  });

  it("leaves an advertisement whose port changed under the same pid", () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(discovery(), JSON.stringify({ pid: 4242, port: 16085 }));

    expect(serve.removeOwnedPgDiscoveryFile(discovery(), 4242, 15084)).toBe(false);
    expect(statSync(discovery(), { throwIfNoEntry: false })).toBeDefined();
  });

  it("does not claim malformed or legacy records without a pid", () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(discovery(), JSON.stringify({ port: 15084 }));
    expect(serve.removeOwnedPgDiscoveryFile(discovery(), 4242, 15084)).toBe(false);
    writeFileSync(discovery(), "not json");
    expect(serve.removeOwnedPgDiscoveryFile(discovery(), 4242, 15084)).toBe(false);
  });
});

describe("isPortAccepting", () => {
  it("is true for a live listener and false for a free port", async () => {
    const { createServer } = await import("node:net");
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    expect(await serve.isPortAccepting(port)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await serve.isPortAccepting(port)).toBe(false);
  });

  it("is false for an invalid port", async () => {
    expect(await serve.isPortAccepting(0)).toBe(false);
    expect(await serve.isPortAccepting(-1)).toBe(false);
  });
});

describe("sticky operator port (stale-port-pin class fix, 2026-07-07)", () => {
  const portMemory = () => join(pcDir(), "operator-port.json");
  afterEach(() => {
    rmSync(portMemory(), { force: true });
  });

  it("readRememberedPort round-trips a persisted port and rejects missing/corrupt/invalid", () => {
    expect(serve.readRememberedPort()).toBeNull();
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(portMemory(), JSON.stringify({ port: 17333 }));
    expect(serve.readRememberedPort()).toBe(17333);
    writeFileSync(portMemory(), "not-json{");
    expect(serve.readRememberedPort()).toBeNull();
    writeFileSync(portMemory(), JSON.stringify({ port: 0 }));
    expect(serve.readRememberedPort()).toBeNull();
    writeFileSync(portMemory(), JSON.stringify({ port: 99999 }));
    expect(serve.readRememberedPort()).toBeNull();
  });

  it("portAvailable is true for a free port and false for a held one", async () => {
    const { createServer } = await import("node:net");
    const holder = createServer();
    const held = await new Promise<number>((resolve) => {
      holder.listen(0, "127.0.0.1", () => {
        resolve((holder.address() as { port: number }).port);
      });
    });
    try {
      expect(await serve.portAvailable(held, "127.0.0.1")).toBe(false);
    } finally {
      await new Promise((r) => holder.close(r));
    }
    expect(await serve.portAvailable(held, "127.0.0.1")).toBe(true);
  });

  it("resolveStickyPort prefers the remembered port on the desktop when free — a restart keeps pinned client URLs valid", async () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(portMemory(), JSON.stringify({ port: 18742 }));
    const port = await serve.resolveStickyPort(19999, "127.0.0.1", {
      PAPERCUSP_DESKTOP: "1",
    });
    expect(port).toBe(18742);
  });

  it("resolveStickyPort falls back to the launcher hint when the remembered port is taken", async () => {
    const { createServer } = await import("node:net");
    const holder = createServer();
    const held = await new Promise<number>((resolve) => {
      holder.listen(0, "127.0.0.1", () => {
        resolve((holder.address() as { port: number }).port);
      });
    });
    try {
      mkdirSync(pcDir(), { recursive: true });
      writeFileSync(portMemory(), JSON.stringify({ port: held }));
      const port = await serve.resolveStickyPort(19999, "127.0.0.1", {
        PAPERCUSP_DESKTOP: "1",
      });
      expect(port).toBe(19999);
    } finally {
      await new Promise((r) => holder.close(r));
    }
  });

  it("resolveStickyPort NEVER second-guesses a non-desktop boot (dev box / tests pin their port deliberately)", async () => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(portMemory(), JSON.stringify({ port: 18742 }));
    expect(await serve.resolveStickyPort(3070, "127.0.0.1", {})).toBe(3070);
    expect(
      await serve.resolveStickyPort(3070, "127.0.0.1", {
        PAPERCUSP_DESKTOP: "0",
      }),
    ).toBe(3070);
  });

  it("resolveStickyPort with no memory returns the hint (first desktop boot seeds it later)", async () => {
    expect(
      await serve.resolveStickyPort(19999, "127.0.0.1", {
        PAPERCUSP_DESKTOP: "1",
      }),
    ).toBe(19999);
  });
});

// The `--ensure` reconciliation and the sticky-port resolution are ORDERED in
// main(): resolving the port first (as it once did) probed a port the
// build-mismatched operator was still holding, so every update restart fell
// back to the launcher's random hint and moved the operator to a new address —
// defeating the sticky port in the one case pinned client URLs most need it.
describe("--ensure reconciliation frees the sticky port before it is resolved (EI-9002 follow-up)", () => {
  const portMemory = () => join(pcDir(), "operator-port.json");

  /** A live stand-in operator: answers any HTTP probe, reports its port. */
  async function spawnFakeOperator(): Promise<{
    pid: number;
    port: number;
    kill: () => void;
  }> {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const s = require('http').createServer((_q, r) => r.end('ok'));" +
          "s.listen(0, '127.0.0.1', () => console.log(s.address().port));",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("fake operator never reported a port")),
        5000,
      );
      child.stdout!.once("data", (b: Buffer) => {
        clearTimeout(t);
        resolve(Number(b.toString().trim()));
      });
    });
    return {
      pid: child.pid!,
      port,
      kill: () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      },
    };
  }

  const writeDiscovery = (
    pid: number,
    port: number,
    build: { version: string; sha: string },
  ) => {
    mkdirSync(pcDir(), { recursive: true });
    writeFileSync(
      operatorJson(),
      JSON.stringify({
        httpUrl: `http://127.0.0.1:${port}`,
        port,
        token: null,
        pid,
        startedAt: Date.now(),
        ...build,
      }),
    );
  };

  afterEach(() => {
    rmSync(portMemory(), { force: true });
    rmSync(operatorJson(), { force: true });
  });

  it("adopts a same-build operator — never kills it", async () => {
    const op = await spawnFakeOperator();
    try {
      writeDiscovery(op.pid, op.port, { version: "0.0.6", sha: "same-sha" });
      const reuse = await serve.reconcileEnsure({
        sha: "same-sha",
        version: "0.0.6",
      });
      expect(reuse?.pid).toBe(op.pid);
      expect(serve.pidAlive(op.pid)).toBe(true);
    } finally {
      op.kill();
    }
  });

  it("refuses a build-mismatched operator and leaves its sticky port re-bindable — an update must not MOVE the operator", async () => {
    const op = await spawnFakeOperator();
    try {
      writeDiscovery(op.pid, op.port, { version: "0.0.5", sha: "old-sha" });
      writeFileSync(portMemory(), JSON.stringify({ port: op.port }));

      expect(
        await serve.reconcileEnsure({ sha: "new-sha", version: "0.0.6" }),
      ).toBeNull();
      expect(serve.pidAlive(op.pid)).toBe(false);

      // main() resolves its bind port at exactly this point. The port the
      // refused operator just released must win over the launcher's hint.
      const hint = op.port === 19999 ? 19998 : 19999;
      expect(
        await serve.resolveStickyPort(hint, "127.0.0.1", {
          PAPERCUSP_DESKTOP: "1",
        }),
      ).toBe(op.port);
    } finally {
      op.kill();
    }
  });

  it("refuses to replace a NEWER running operator and leaves it alive (WI-10005958)", async () => {
    const op = await spawnFakeOperator();
    try {
      writeDiscovery(op.pid, op.port, { version: "0.0.0", sha: "rig-sha" });
      await expect(
        serve.reconcileEnsure({ sha: "installed-sha", version: "0.0.26" }, {}),
      ).rejects.toThrow(/NEWER build[\s\S]*PAPERCUSP_ALLOW_OPERATOR_DOWNGRADE/);
      expect(serve.pidAlive(op.pid)).toBe(true);
    } finally {
      op.kill();
    }
  });

  it("PAPERCUSP_ALLOW_OPERATOR_DOWNGRADE=1 restores the EI-9002 replace for a newer operator", async () => {
    const op = await spawnFakeOperator();
    try {
      writeDiscovery(op.pid, op.port, { version: "0.0.0", sha: "rig-sha" });
      expect(
        await serve.reconcileEnsure(
          { sha: "installed-sha", version: "0.0.26" },
          { PAPERCUSP_ALLOW_OPERATOR_DOWNGRADE: "1" },
        ),
      ).toBeNull();
      expect(serve.pidAlive(op.pid)).toBe(false);
    } finally {
      op.kill();
    }
  });

  // The test above proves the MECHANISM (a refused operator's port is free the
  // moment reconcileEnsure resolves) but it calls the two steps in the right
  // order itself. The regression lived in main()'s ordering, which no behavior
  // test reaches without booting a server — so assert it on the source.
  it("main() resolves the bind port AFTER reconcileEnsure, never before", () => {
    const src = readFileSync(new URL("./serve.ts", import.meta.url), "utf8");
    const reconciledAt = src.indexOf("await reconcileEnsure()");
    const portResolvedAt = src.indexOf(
      "await resolveStickyPort(honoPortHint, hostname)",
    );
    expect(
      reconciledAt,
      "reconcileEnsure() call went missing from main()",
    ).toBeGreaterThan(-1);
    expect(
      portResolvedAt,
      "resolveStickyPort() call went missing from main()",
    ).toBeGreaterThan(-1);
    expect(portResolvedAt).toBeGreaterThan(reconciledAt);
  });
});

// WI-3385 recurrence guard: the launcher spawns serve with PORT /
// PAPERCUSP_HONO_PORT / PAPERCUSP_OPERATOR_BASE all naming its cold-start
// port HINT; when resolveStickyPort re-binds the remembered port instead
// (every desktop boot after the first), any consumer reading those envs —
// worst: the endpoint-IPC sys:http upstream base, i.e. ALL bridged sync
// SSE + REST — dialed the dead hint port forever (the permanent "Operator
// connection lost" banner). The resolved port must overwrite ALL of them
// before the host modules load.
describe("exportResolvedPortEnv (stale launcher-hint env class fix, WI-3385)", () => {
  it("overwrites every port-naming env var with the RESOLVED port", () => {
    const env: NodeJS.ProcessEnv = {
      PORT: "17183", // the launcher's hint — nothing listens here after re-bind
      PAPERCUSP_HONO_PORT: "17183",
      PAPERCUSP_OPERATOR_BASE: "http://localhost:17183",
    };
    serve.exportResolvedPortEnv(17366, env);
    expect(env.PORT).toBe("17366");
    expect(env.PAPERCUSP_HONO_PORT).toBe("17366");
    expect(env.PAPERCUSP_OPERATOR_BASE).toBe("http://127.0.0.1:17366");
  });

  it("seeds the vars even when the launcher never set them (first boot / bare env)", () => {
    const env: NodeJS.ProcessEnv = {};
    serve.exportResolvedPortEnv(3070, env);
    expect(env.PORT).toBe("3070");
    expect(env.PAPERCUSP_HONO_PORT).toBe("3070");
    expect(env.PAPERCUSP_OPERATOR_BASE).toBe("http://127.0.0.1:3070");
  });

  it("is a loopback-IP base (127.0.0.1, never localhost — no resolver/IPv6 ambiguity)", () => {
    const env: NodeJS.ProcessEnv = {};
    serve.exportResolvedPortEnv(17366, env);
    expect(env.PAPERCUSP_OPERATOR_BASE).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

// EI-11342 recurrence guard: a packaged env-sidecar (a rig / env-switcher
// sibling, PAPERCUSP_ENV_OPERATOR_ID set) whose per-instance port override
// never reached it fell back to the baked default 3070 — the PRODUCTION
// operator's port on the same box — won a bind race against a mid-restart
// papercup-dev-api, and crash-looped prod + blacked out fleet-wide MCP for
// ~7 min. resolveHonoPortHint() must FAIL LOUDLY for a portless env-sidecar
// instead of ever returning 3070, while leaving the primary operator's
// default-3070 behavior byte-for-byte unchanged.
describe("resolveHonoPortHint env-sidecar prod-port-squat guard (EI-11342)", () => {
  it("THROWS for an env-sidecar with no explicit port (never falls back to 3070)", () => {
    expect(() => serve.resolveHonoPortHint({}, "lane-a-fed")).toThrow(
      /EI-11342/,
    );
    // must not leak the prod default in any form
    expect(() => serve.resolveHonoPortHint({}, "lane-a-fed")).toThrow(/3070/);
  });

  it("THROWS for an env-sidecar with an invalid/blank port override", () => {
    expect(() =>
      serve.resolveHonoPortHint({ PAPERCUSP_HONO_PORT: "" }, "dev"),
    ).toThrow(/requires an explicit/);
    expect(() =>
      serve.resolveHonoPortHint({ PORT: "not-a-port" }, "dev"),
    ).toThrow(/requires an explicit/);
    expect(() =>
      serve.resolveHonoPortHint({ PAPERCUSP_HONO_PORT: "0" }, "dev"),
    ).toThrow();
    expect(() =>
      serve.resolveHonoPortHint({ PAPERCUSP_HONO_PORT: "70000" }, "dev"),
    ).toThrow();
  });

  it("accepts an env-sidecar with its fixed per-instance port (the legit launcher path)", () => {
    // env-operator-launcher.ts always sets PAPERCUSP_HONO_PORT alongside
    // PAPERCUSP_ENV_OPERATOR_ID — that path must keep working.
    expect(
      serve.resolveHonoPortHint({ PAPERCUSP_HONO_PORT: "18071" }, "lane-a-fed"),
    ).toBe(18071);
    expect(serve.resolveHonoPortHint({ PORT: "3170" }, "staging")).toBe(3170);
  });

  it("leaves the PRIMARY operator path unchanged (defaults to 3070 when unset)", () => {
    expect(serve.resolveHonoPortHint({}, null)).toBe(3070);
    expect(
      serve.resolveHonoPortHint({ PAPERCUSP_HONO_PORT: "17999" }, null),
    ).toBe(17999);
    expect(serve.resolveHonoPortHint({ PORT: "17999" }, null)).toBe(17999);
  });

  it("is wired into main() (the resolved hint feeds the ENV_OPERATOR_ID port branch)", () => {
    const src = readFileSync(new URL("./serve.ts", import.meta.url), "utf8");
    expect(src).toContain("resolveHonoPortHint(process.env, ENV_OPERATOR_ID)");
  });
});

// WI-5654 recurrence guard: a detached (fire-and-forget) boot-time
// background task inside runBootstrap() (memory embedder warm-up,
// hyperbee-substrate boot, OMP integration, spawner/embed-sidecar
// warm-ups, …) that misses its own `.catch()` used to become a bare Node
// unhandledRejection with ZERO process-level listeners — serve.ts (the
// packaged desktop entrypoint) never imports hono-host.ts's guard — which
// (per Node's default `--unhandled-rejections=throw`) killed the ENTIRE
// desktop app before it ever bound its HTTP port, with nothing but a raw
// V8 stack dump as evidence. Live repro: the live-federation-gate crashed
// 3/3 attempts (2026-07-20) when WI-5638 stripped harrier's HF model cache
// from the bundle and the boot-time embedder warm-up's first-use model
// fetch rejected with zero listeners downstream. This guard asserts the
// module registers its own top-level safety net so that class of fault is
// logged and SURVIVED instead of taking the whole app down.
describe("boot-time background-task safety net (WI-5654)", () => {
  it("registers process-level unhandledRejection + uncaughtException handlers on import", () => {
    // `serve` was imported once in beforeAll — its top-level process.on(...)
    // calls have already run against the REAL process object.
    expect(process.listenerCount("unhandledRejection")).toBeGreaterThan(0);
    expect(process.listenerCount("uncaughtException")).toBeGreaterThan(0);
  });

  it("logs (never throws/exits) a detached rejection shaped like the WI-5654 fault, instead of crashing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fault = new Error("Unable to get model file path or buffer.");
      // Directly exercise the registered listeners the way Node's own
      // unhandled-rejection dispatch would — without actually leaving an
      // unhandled promise around for the REAL runtime to also act on.
      expect(() => {
        process.emit("unhandledRejection", fault, Promise.reject(fault).catch(() => {}));
      }).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("non-fatal unhandledRejection"),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("is registered BEFORE runBootstrap() is invoked in main() (ordering is load-bearing)", () => {
    const src = readFileSync(new URL("./serve.ts", import.meta.url), "utf8");
    const handlerIdx = src.indexOf("process.on('unhandledRejection'");
    const runBootstrapCallIdx = src.indexOf("runBootstrap();");
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(runBootstrapCallIdx).toBeGreaterThan(-1);
    expect(handlerIdx).toBeLessThan(runBootstrapCallIdx);
  });
});

// EI-20952729544817284 recurrence guard: the desktop sidecar is bundled from
// serve.ts, while the original cross-service booted-handles wiring lived only
// in hono-host.ts. Bundle reachability was a false-positive because read routes
// kept the publisher module's bytes in serve.mjs without ever invoking it.
describe("packaged booted-handles publisher lifecycle (EI-20952729544817284)", () => {
  const source = () => readFileSync(new URL("./serve.ts", import.meta.url), "utf8");

  it("starts the publisher after bootstrap and before accepting HTTP traffic", () => {
    const src = source();
    const bootstrapIdx = src.indexOf("runBootstrap();");
    const publisherIdx = src.indexOf(
      "bootedHandlesPgPublisher = startBootedHandlesPgPublisher({});",
    );
    const serveIdx = src.indexOf("server = serve(");

    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(publisherIdx).toBeGreaterThan(bootstrapIdx);
    expect(serveIdx).toBeGreaterThan(publisherIdx);
  });

  it("stops the publisher in both signal cleanup and startup-failure cleanup", () => {
    const src = source();
    const syncCleanupIdx = src.indexOf("syncCleanup: () => {");
    const firstStopIdx = src.indexOf("bootedHandlesPgPublisher?.stop();", syncCleanupIdx);
    const publisherIdx = src.indexOf(
      "bootedHandlesPgPublisher = startBootedHandlesPgPublisher({});",
    );
    const catchIdx = src.indexOf("\n  } catch (e) {", publisherIdx);
    const catchStopIdx = src.indexOf("bootedHandlesPgPublisher?.stop();", catchIdx);

    expect(syncCleanupIdx).toBeGreaterThan(-1);
    expect(firstStopIdx).toBeGreaterThan(syncCleanupIdx);
    expect(firstStopIdx).toBeLessThan(publisherIdx);
    expect(catchIdx).toBeGreaterThan(publisherIdx);
    expect(catchStopIdx).toBeGreaterThan(catchIdx);
  });
});

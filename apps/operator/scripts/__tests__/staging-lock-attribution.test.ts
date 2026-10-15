import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const HELPER = join(REPO_ROOT, "apps/operator/scripts/systemd/staging-lock-attribution.sh");
// PROBE_DROPIN lets scripts/mutation-probe.sh point this suite at a mutated COPY
// of the drop-in (copy-out mode) instead of mutating the shared tree.
const DROPIN =
  process.env.PROBE_DROPIN ??
  join(REPO_ROOT, "apps/operator/scripts/systemd/papercup-staging-api.service.d/95-bundled-entry.conf");
const SYNC = join(REPO_ROOT, "apps/operator/bin/release/sync-staging-checkout.sh");

// A HANG guard for the synchronous helper runs, not a performance budget. spawnSync
// blocks the worker, so vitest's own timeout cannot fire and this is the only cap.
// At 10 s it killed a healthy helper under gate load (status null, measured
// 2026-10-11 at b14fa43c with host load ~200; WI-6554700010008342).
const SPAWN_TIMEOUT_MS = 60_000;
// The reuse case must observe its holder STILL holding the lock after the helper
// returns, so the holder outlives every allowed helper run; the finally kills it.
const REUSE_HOLDER_HOLD_S = 90;

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function shell(command: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/usr/bin/bash", ["-c", command], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
}

function records(output: string): Record<string, string>[] {
  const prefix = "[staging-lock-attribution] ";
  return output.split("\n").filter((line) => line.startsWith(prefix)).map((line) =>
    Object.fromEntries(line.slice(prefix.length).split(" ").map((field) => {
      const separator = field.indexOf("=");
      return [field.slice(0, separator), field.slice(separator + 1)];
    })),
  );
}

function lockTarget(lockPath: string): string {
  const stat = spawnSync("stat", ["-Lc", "%d:%i", lockPath], {
    encoding: "utf8",
  });
  if (stat.status !== 0) throw new Error(stat.stderr || "stat failed");
  const [deviceText, inode] = stat.stdout.trim().split(":");
  const device = BigInt(deviceText);
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn);
  const minor = (device & 0xffn) | ((device >> 12n) & ~0xffn);
  return (
    major.toString(16).padStart(2, "0") +
    ":" +
    minor.toString(16).padStart(2, "0") +
    ":" +
    inode
  );
}

function mockSystemctl(binDir: string, properties: string): void {
  const path = join(binDir, "systemctl");
  writeFileSync(
    path,
    "#!/usr/bin/env bash\nprintf '%s\\n' '" +
      properties.replaceAll("\n", "' '") +
      "'\n",
    { mode: 0o700 },
  );
}

// npm-install-safe.mjs is COPIED into a fixture (its direct-entry guard compares argv[1] with
// import.meta.url), so every relative module it imports must also exist beside the copy. Derive
// that set from the CLI's own source instead of hand-listing it: a hand list went stale each time
// the CLI gained an import (check-partial-install.mjs, dependency-lock-tree-audit.mjs;
// WI-6554700010009809). Symlinks resolve to their real path, so transitive imports need nothing.
function linkRelativeImports(sourceFile: string, copyFile: string): void {
  const source = readFileSync(sourceFile, "utf8");
  for (const match of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = resolve(dirname(copyFile), match[1]);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(resolve(dirname(sourceFile), match[1]), target);
  }
}

function completeGenerationFixture(dir: string) {
  const sha = "a".repeat(40);
  const generation = join(dir, "papercusp-staging.generations/.candidate-test");
  const repo = join(generation, "checkout");
  const operator = join(repo, "apps/operator");
  const binDir = join(dir, "bin");
  const probe = join(dir, "proof-checked");
  const rebuilt = join(dir, "bundle-rebuilt");
  const proofValid = join(dir, "proof-valid");
  mkdirSync(join(operator, "bin"), { recursive: true });
  mkdirSync(join(operator, "dist-host"));
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(binDir);
  writeFileSync(join(generation, ".ready"), sha + "\n");
  writeFileSync(proofValid, "valid\n");
  writeFileSync(join(operator, "bin/hono-host.ts"), "export const ready = true;\n");
  writeFileSync(join(operator, "dist-host/hono-host.mjs"), "export const ready = true;\n");
  writeFileSync(join(operator, "dist-host/.bundle-fresh.json"), "{}\n");
  writeFileSync(join(binDir, "git"), `#!/usr/bin/env bash\nprintf '%s\\n' '${sha}'\n`, { mode: 0o700 });
  mockSystemctl(binDir, "ActiveState=activating\nSubState=start-pre\nMainPID=0\nType=notify\nResult=success");
  // Exercise the pre-start protocol without constructing the entire host graph.
  // bundle-host-freshness's own suite verifies the real proof and drift checks.
  writeFileSync(join(repo, "scripts/npm-install-safe.mjs"),
    'import { spawnSync } from "node:child_process";\n' +
    'const args = process.argv.slice(2); const command = args.slice(args.indexOf("--") + 1);\n' +
    'if (args[0] !== "--repo-root" || args[2] !== "--exec-under-lock") process.exit(64);\n' +
    'const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", cwd: args[1] });\n' +
    'process.exit(result.status ?? 1);\n');
  writeFileSync(join(operator, "bin/bundle-host-freshness.mjs"),
    'import { existsSync, writeFileSync } from "node:fs";\n' +
    'const args = process.argv.slice(2);\n' +
    `writeFileSync(${JSON.stringify(probe)}, JSON.stringify(process.argv.slice(2)));\n` +
    'if (!["--entry", "--outfile", "--manifest"].every(flag => existsSync(args[args.indexOf(flag) + 1]))) process.exit(1);\n' +
    `process.exit(existsSync(${JSON.stringify(proofValid)}) ? 0 : 1);\n`);
  const bundle = join(operator, "bin/bundle-host.sh");
  writeFileSync(bundle, `#!/usr/bin/env bash\nprintf rebuilt > '${rebuilt}'\n`, { mode: 0o700 });
  return { sha, generation, repo, operator, binDir, probe, rebuilt, proofValid, bundle };
}

describe("staging lock attribution", () => {
  it("checks a real bundle proof through the real repo install mutex before reusing it", () => {
    const dir = makeTempDir("staging-generation-real-proof-");
    try {
      const fixture = completeGenerationFixture(dir);
      rmSync(join(fixture.binDir, "git"));
      rmSync(join(fixture.repo, "scripts/npm-install-safe.mjs"));
      rmSync(join(fixture.operator, "bin/bundle-host-freshness.mjs"));
      // This CLI's direct-entry guard compares argv[1] with import.meta.url.
      // Copy its entry file, as a real generation does, and link library imports.
      writeFileSync(join(fixture.repo, "scripts/npm-install-safe.mjs"), readFileSync(join(REPO_ROOT, "scripts/npm-install-safe.mjs")));
      symlinkSync(join(REPO_ROOT, "scripts/lib"), join(fixture.repo, "scripts/lib"), "dir");
      linkRelativeImports(join(REPO_ROOT, "scripts/npm-install-safe.mjs"), join(fixture.repo, "scripts/npm-install-safe.mjs"));
      symlinkSync(join(REPO_ROOT, "apps/operator/bin/bundle-host-freshness.mjs"), join(fixture.operator, "bin/bundle-host-freshness.mjs"));
      writeFileSync(join(fixture.repo, ".gitignore"), "apps/operator/dist-host/\n");
      // These commits belong only to the temporary fixture, as in the existing
      // staging-isolated-bundle proof suite; the shared tree is never committed.
      const git = (...args: string[]) => {
        const result = spawnSync("git", ["-C", fixture.repo, "-c", "user.email=test@example.test", "-c", "user.name=test", ...args], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git("init", "-q");
      git("add", ".gitignore", "apps", "scripts");
      git("commit", "-q", "-m", "proof fixture");
      writeFileSync(join(fixture.generation, ".ready"), git("rev-parse", "HEAD") + "\n");
      const stamp = spawnSync(process.execPath, [join(fixture.operator, "bin/bundle-host-freshness.mjs"),
        "stamp", "--repo-root", fixture.repo, "--entry", join(fixture.operator, "bin/hono-host.ts"),
        "--outfile", join(fixture.operator, "dist-host/hono-host.mjs"),
        "--manifest", join(fixture.operator, "dist-host/.bundle-fresh.json")], { encoding: "utf8" });
      expect(stamp.status, stamp.stderr).toBe(0);
      const result = spawnSync("/usr/bin/bash", [HELPER, "api-pre", join(dir, "sync.lock"), fixture.bundle], {
        cwd: fixture.operator,
        env: { ...process.env, PAPERCUSP_BUNDLE_REUSE_FRESH: "1", PAPERCUSP_INSTALL_MUTEX_HELD: "0" },
        encoding: "utf8", timeout: SPAWN_TIMEOUT_MS,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("NPM_INSTALL_SAFE guarding reader");
      expect(result.stderr).toContain("lock_scope=immutable_generation");
      expect(existsSync(fixture.rebuilt)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reuses a verified complete generation while another candidate holds the checkout lock", async () => {
    const dir = makeTempDir("staging-generation-reuse-");
    let holder: ReturnType<typeof spawn> | undefined;
    let holderExit: Promise<void> | undefined;
    try {
      expect(SPAWN_TIMEOUT_MS).toBeLessThan(REUSE_HOLDER_HOLD_S * 1000);
      const fixture = completeGenerationFixture(dir);
      const lock = join(dir, "sync.lock");
      const ready = join(dir, "holder-ready");
      holder = spawn("/usr/bin/flock", ["--exclusive", "--no-fork", lock,
        "/usr/bin/bash", "-c", 'touch "$1"; exec /usr/bin/sleep "$2"', "holder", ready, String(REUSE_HOLDER_HOLD_S)], { stdio: "ignore" });
      holderExit = new Promise((done) => holder?.once("exit", () => done()));
      for (let i = 0; i < 300 && !existsSync(ready); i += 1) {
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(existsSync(ready)).toBe(true);
      const result = spawnSync("/usr/bin/bash", [HELPER, "api-pre", lock, fixture.bundle], {
        cwd: fixture.operator,
        env: { ...process.env, PATH: fixture.binDir + ":" + process.env.PATH, PAPERCUSP_BUNDLE_REUSE_FRESH: "1", INVOCATION_ID: "reuse-attempt-42" },
        encoding: "utf8", timeout: SPAWN_TIMEOUT_MS,
      });
      expect(result.status).toBe(0);
      expect(existsSync(fixture.rebuilt)).toBe(false);
      expect(JSON.parse(readFileSync(fixture.probe, "utf8"))).toEqual([
        "check", "--repo-root", fixture.repo, "--entry", join(fixture.operator, "bin/hono-host.ts"),
        "--outfile", join(fixture.operator, "dist-host/hono-host.mjs"),
        "--manifest", join(fixture.operator, "dist-host/.bundle-fresh.json"),
      ]);
      expect(result.stderr).toContain("lock_scope=immutable_generation");
      expect(records(result.stderr)).toEqual([
        expect.objectContaining({
          event: "start", surface: "start-pre", attempt_id: "reuse-attempt-42",
          lock_path: lock, lock_mode: "shared", state: "wait_start",
          wait_start_ms: expect.stringMatching(/^\d+$/),
        }),
        expect.objectContaining({
          event: "end", surface: "start-pre", attempt_id: "reuse-attempt-42",
          lock_path: lock, lock_mode: "shared", state: "complete",
          acquisition_outcome: "not_required", bundle_outcome: "proof_reused",
          wait_elapsed_ms: expect.stringMatching(/^\d+$/),
          api_active_state: "activating", api_sub_state: "start-pre",
          api_readiness: "not_ready_or_unknown",
        }),
      ]);
      // A physical lock probe distinguishes reuse from merely waiting for the
      // candidate to finish; this is not a wall-clock performance assertion.
      expect(spawnSync("/usr/bin/flock", ["-n", lock, "true"]).status).toBe(1);
    } finally {
      if (holder && holder.exitCode === null) holder.kill("SIGTERM");
      await holderExit;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["missing readiness", "different source", "rejected proof"])(
    "keeps the locked rebuild when a generation has %s", (reason) => {
      const dir = makeTempDir("staging-generation-fallback-");
      try {
        const fixture = completeGenerationFixture(dir);
        if (reason === "missing readiness") rmSync(join(fixture.generation, ".ready"));
        if (reason === "different source") writeFileSync(join(fixture.generation, ".ready"), "b".repeat(40));
        if (reason === "rejected proof") rmSync(fixture.proofValid);
        const result = spawnSync("/usr/bin/bash", [HELPER, "api-pre", join(dir, "sync.lock"), fixture.bundle], {
          cwd: fixture.operator,
          env: { ...process.env, PATH: fixture.binDir + ":" + process.env.PATH, PAPERCUSP_BUNDLE_REUSE_FRESH: "1" },
          encoding: "utf8", timeout: SPAWN_TIMEOUT_MS,
        });
        expect(result.status).toBe(0);
        expect(existsSync(fixture.rebuilt)).toBe(true);
        expect(result.stderr).toContain("acquisition_outcome=acquired");
        expect(result.stderr).not.toContain("lock_scope=immutable_generation");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it("matches a conflicting holder by exact device/inode and excludes waiters", () => {
    const dir = makeTempDir("staging-lock-parser-");
    try {
      const lock = join(dir, "sync.lock");
      const procLocks = join(dir, "proc-locks");
      writeFileSync(lock, "");
      const target = lockTarget(lock);
      const [major, minor, inode] = target.split(":");
      const otherInode = (BigInt(inode) + 1n).toString();
      const currentComm = readFileSync("/proc/" + process.pid + "/comm", "utf8")
        .trim()
        .replace(/[^A-Za-z0-9_.-]/g, "_");
      writeFileSync(
        procLocks,
        [
          "1: FLOCK ADVISORY READ " + process.pid + " " + target + " 0 EOF",
          "2: -> FLOCK ADVISORY WRITE " + process.pid + " " + target + " 0 EOF",
          "3: FLOCK ADVISORY WRITE " +
            process.pid +
            " " +
            major +
            ":" +
            minor +
            ":" +
            otherInode +
            " 0 EOF",
          "4: FLOCK ADVISORY WRITE " + process.pid + " " + target + " 0 EOF",
        ].join("\n"),
      );

      const result = shell(
        'source "$HELPER"; staging_lock_holder_fields "$LOCK" shared "$PROC_LOCKS"',
        { HELPER, LOCK: lock, PROC_LOCKS: procLocks },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        "holder_pid=" + process.pid + " holder_comm=" + currentComm,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["no match", "missing proc file", "empty proc file", "dead holder", "waiter only"])(
    "reports an explicit unknown holder for %s", (reason) => {
    const dir = makeTempDir("staging-lock-unknown-");
    try {
      const lock = join(dir, "sync.lock");
      const procLocks = join(dir, "proc-locks");
      writeFileSync(lock, "");
      if (reason === "no match") writeFileSync(procLocks, "1: FLOCK ADVISORY WRITE 1234 00:00:999 0 EOF\n");
      if (reason === "empty proc file") writeFileSync(procLocks, "");
      if (reason === "dead holder") writeFileSync(procLocks, "1: FLOCK ADVISORY WRITE 0 " + lockTarget(lock) + " 0 EOF\n");
      if (reason === "waiter only") writeFileSync(procLocks, "1: -> FLOCK ADVISORY WRITE " + process.pid + " " + lockTarget(lock) + " 0 EOF\n");

      const result = shell(
        'source "$HELPER"; staging_lock_holder_fields "$LOCK" exclusive "$PROC_LOCKS"',
        { HELPER, LOCK: lock, PROC_LOCKS: procLocks },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("holder_pid=unknown holder_comm=unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the staging-sync skip and exact holder under temporary-lock contention", async () => {
    const dir = makeTempDir("staging-sync-contention-");
    let holder: ReturnType<typeof spawn> | undefined;
    let holderExit: Promise<void> | undefined;
    try {
      const lock = join(dir, "sync.lock");
      const ready = join(dir, "holder-ready");
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      mockSystemctl(binDir, "");
      holder = spawn("/usr/bin/flock", ["--exclusive", "--no-fork", lock,
        "/usr/bin/bash", "-c", 'touch "$1"; exec /usr/bin/sleep 90', "holder", ready], { stdio: "ignore" });
      holderExit = new Promise((done) => holder?.once("exit", () => done()));
      for (let i = 0; i < 300 && !existsSync(ready); i += 1) {
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(existsSync(ready)).toBe(true);

      // Execute the production admission block, stopping before any checkout,
      // build, or restart work. Only its hard-coded lock path is substituted.
      const sync = readFileSync(SYNC, "utf8");
      const start = sync.indexOf('STAGING_SYNC_LOCK_PATH="/tmp/papercup-staging-sync.lock"');
      const end = sync.indexOf('[ -d "$INTEGRATION_ROOT/.git" ]', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const admission = sync.slice(start, end).replace(
        'STAGING_SYNC_LOCK_PATH="/tmp/papercup-staging-sync.lock"', 'STAGING_SYNC_LOCK_PATH="$TEST_LOCK"',
      );
      const result = shell('source "$HELPER"\nlog() { printf "%s\\n" "$*"; }\n' + admission + '\nprintf sync-proceeded', {
        HELPER, TEST_LOCK: lock, PATH: binDir + ":" + process.env.PATH,
        INVOCATION_ID: "sync-attempt-42",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("skipping this tick");
      expect(result.stdout).not.toContain("sync-proceeded");
      const entries = records(result.stderr);
      expect(entries).toEqual([
        expect.objectContaining({ event: "start", surface: "staging-sync", state: "wait_start" }),
        expect.objectContaining({
          event: "end", surface: "staging-sync", state: "complete",
          acquisition_outcome: "not_acquired", holder_pid: String(holder.pid),
          holder_comm: expect.stringMatching(/^(sleep|flock)$/),
          wait_elapsed_ms: expect.stringMatching(/^\d+$/),
        }),
      ]);
      for (const entry of entries) expect(entry).toMatchObject({
        attempt_id: "sync-attempt-42", lock_path: lock, lock_mode: "exclusive",
        wait_start_ms: expect.stringMatching(/^\d+$/),
      });
      expect(spawnSync("/usr/bin/flock", ["-n", lock, "true"]).status).toBe(1);
    } finally {
      if (holder && holder.exitCode === null) holder.kill("SIGTERM");
      await holderExit;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records bounded wait samples and exact holder details under temporary-lock contention", async () => {
    const dir = makeTempDir("staging-lock-contention-");
    let holder: ReturnType<typeof spawn> | undefined;
    let holderExit: Promise<void> | undefined;
    try {
      const lock = join(dir, "sync.lock");
      const bundle = join(dir, "fixture-bundle.sh");
      const binDir = join(dir, "bin");
      const ready = join(dir, "holder-ready");
      mkdirSync(binDir);
      writeFileSync(lock, "");
      writeFileSync(
        bundle,
        "#!/usr/bin/env bash\nprintf 'fixture-bundle-ran\\n'\n",
        { mode: 0o700 },
      );
      mockSystemctl(
        binDir,
        "ActiveState=activating\nSubState=start-pre\nMainPID=0\nType=notify\nResult=success",
      );

      holder = spawn(
        "/usr/bin/flock",
        [
          "--exclusive",
          "--no-fork",
          lock,
          "/usr/bin/bash",
          "-c",
          'touch "$1"; exec /usr/bin/sleep 6',
          "staging-lock-holder",
          ready,
        ],
        { stdio: "ignore" },
      );
      holderExit = new Promise((resolveExit) => holder?.once("exit", () => resolveExit()));
      for (let i = 0; i < 300 && !existsSync(ready); i += 1) {
        await new Promise((resolveReady) => setTimeout(resolveReady, 10));
      }
      expect(existsSync(ready)).toBe(true);

      const result = spawnSync(
        "/usr/bin/bash",
        [HELPER, "api-pre", lock, bundle],
        {
          env: {
            ...process.env,
            PATH: binDir + ":" + (process.env.PATH ?? ""),
            INVOCATION_ID: "test-start-pre-attempt-42",
          },
          encoding: "utf8",
          timeout: SPAWN_TIMEOUT_MS,
        },
      );
      expect(result.status).toBe(0);
      const output = result.stdout + "\n" + result.stderr;
      expect(output).toContain(
        "event=start surface=start-pre attempt_id=test-start-pre-attempt-42",
      );
      expect(output).toContain("event=acquired surface=start-pre");
      expect(output).toContain("acquisition_outcome=acquired");
      expect(output).toContain("readiness_phase=before-execstart");
      expect(output).toContain("api_readiness=not_ready_or_unknown");
      expect(output).toContain("fixture-bundle-ran");
      expect(output).toContain("holder_pid=" + holder.pid);
      expect(output).toMatch(/holder_comm=(sleep|flock)/);
      const sampleCount = (output.match(/event=wait_sample/g) ?? []).length;
      expect(sampleCount).toBeGreaterThan(0);
      expect(sampleCount).toBeLessThanOrEqual(5);
    } finally {
      if (holder && holder.exitCode === null) holder.kill("SIGTERM");
      await holderExit;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["bundle failure", "lock failure"])(
    "preserves %s while unavailable diagnostics stay explicit", (reason) => {
      const dir = makeTempDir("staging-lock-unavailable-");
      try {
        const binDir = join(dir, "bin");
        const bundle = join(dir, "fixture-bundle.sh");
        const lock = reason === "lock failure" ? join(dir, "missing/sync.lock") : join(dir, "sync.lock");
        mkdirSync(binDir);
        writeFileSync(bundle, "#!/usr/bin/env bash\nexit 17\n", { mode: 0o700 });
        for (const command of ["systemctl", "date"]) {
          writeFileSync(join(binDir, command), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
        }
        const result = spawnSync("/usr/bin/bash", [HELPER, "api-pre", lock, bundle], {
          env: { ...process.env, PATH: binDir + ":" + process.env.PATH, INVOCATION_ID: "" },
          encoding: "utf8", timeout: SPAWN_TIMEOUT_MS,
        });
        expect(result.status).toBe(reason === "bundle failure" ? 17 : 66);
        const entries = records(result.stderr);
        expect(entries[0]).toMatchObject({ event: "start", attempt_id: "unavailable", wait_start_ms: "unknown" });
        expect(entries.at(-1)).toMatchObject({
          event: "end", attempt_id: "unavailable", lock_path: lock, lock_mode: "shared",
          acquisition_outcome: reason === "bundle failure" ? "acquired" : "not_acquired",
          wait_elapsed_ms: "unknown", api_active_state: "unknown", api_sub_state: "unknown",
          api_main_pid: "unknown", api_type: "unknown", api_result: "unknown", api_readiness: "unknown",
          ...(reason === "bundle failure" ? { bundle_exit_status: "17", bundle_outcome: "bundle_failed" } : { command_exit_status: "66" }),
        });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it("records ready state from ExecStartPost after Type=notify", () => {
    const dir = makeTempDir("staging-lock-ready-");
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      mockSystemctl(
        binDir,
        "ActiveState=active\nSubState=running\nMainPID=4321\nType=notify\nResult=success",
      );
      const result = spawnSync(
        "/usr/bin/bash",
        [HELPER, "api-post", "papercup-staging-api.service"],
        {
          env: {
            ...process.env,
            PATH: binDir + ":" + (process.env.PATH ?? ""),
            INVOCATION_ID: "test-start-pre-attempt-42",
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "event=api_ready surface=exec-start-post attempt_id=test-start-pre-attempt-42",
      );
      expect(result.stderr).toContain("api_main_pid=4321");
      expect(result.stderr).toContain("api_readiness=ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WI-10005259: the drop-in is symlinked live from the canonical tree but reads the
  // helper from papercusp-staging.current, one generation behind. A generation without
  // the helper crash-looped :3170 (status 127). Run the REAL ExecStartPre the way systemd
  // would (expand %h and $$) against a generation that lacks the helper.
  it("ExecStartPre still bundles under the shared flock when the generation lacks the helper", () => {
    const line = readFileSync(DROPIN, "utf8")
      .split("\n")
      .find((l) => l.startsWith("ExecStartPre="));
    expect(line).toBeDefined();
    const home = makeTempDir("staging-dropin-home-");
    try {
      const root = join(home, "papercupai-workspace/papercusp-staging.current");
      const bin = join(root, "apps/operator/bin");
      mkdirSync(bin, { recursive: true });
      const marker = join(home, "bundled");
      writeFileSync(join(bin, "bundle-host.sh"), `#!/usr/bin/env bash\necho ran > "${marker}"\n`, {
        mode: 0o755,
      });
      expect(existsSync(join(root, "apps/operator/scripts/systemd/staging-lock-attribution.sh"))).toBe(
        false,
      );
      const command = line!
        .slice("ExecStartPre=".length)
        .replaceAll("%h", home)
        .replaceAll("$$", "$")
        .replaceAll("/tmp/papercup-staging-sync.lock", join(home, "fixture-sync.lock"));
      // systemd hands the quoted argument to bash -c; reproduce that split exactly.
      const match = /^\/usr\/bin\/bash -c '(.*)'$/.exec(command);
      expect(match).not.toBeNull();
      const result = spawnSync("/usr/bin/bash", ["-c", match![1]], {
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(marker, "utf8").trim()).toBe("ran");
      expect(result.stderr).toContain("is absent from this staging generation");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("wires the API start/post records and staging-sync lock transitions", () => {
    const dropin = readFileSync(DROPIN, "utf8");
    const sync = readFileSync(SYNC, "utf8");
    expect(dropin).toContain(
      'helper="$$root/apps/operator/scripts/systemd/staging-lock-attribution.sh"',
    );
    expect(dropin).toContain(
      'exec /usr/bin/bash "$$helper" api-pre /tmp/papercup-staging-sync.lock "$$root/apps/operator/bin/bundle-host.sh"',
    );
    // Best-effort ('-'): a missing or failing post hook must not fail the unit.
    expect(dropin).toContain(
      "ExecStartPost=-/usr/bin/bash %h/papercupai-workspace/papercusp-staging.current/apps/operator/scripts/systemd/staging-lock-attribution.sh api-post",
    );
    const attempt = sync.indexOf(
      "state=wait_start lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=exclusive",
    );
    const open = sync.indexOf('exec 9>"$STAGING_SYNC_LOCK_PATH"');
    const acquire = sync.indexOf("if ! flock -n 9", open);
    expect(attempt).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(attempt);
    expect(acquire).toBeGreaterThan(open);
    expect(sync).toContain("state=shared_acquired phase=preflight-restart");
    expect(sync).toContain("state=shared_acquired phase=final-restart");
  });
});

/** Behavioral guard for frozen operator-source survivor cleanup. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../../scripts/verify-tauri-headless.sh");
const source = readFileSync(SCRIPT, "utf8");
const spaCleanupFunction = source.match(/^cleanup_verifier_spa_snapshot\(\) \{[\s\S]*?^\}/m)?.[0];
if (!spaCleanupFunction) throw new Error("Frozen SPA cleanup helper not found");
const reaperStart = source.indexOf("frozen_source_path_is_inside() {");
const reaperEnd = source.indexOf("\nwrite_frozen_source_reaper_script || {", reaperStart);
const reaperFunctions = source.slice(reaperStart, reaperEnd);
const stopStart = source.indexOf("write_stop_script() {");
const stopEnd = source.indexOf("\n# ── EI-11559", stopStart);
const stopFunction = source.slice(stopStart, stopEnd);

function makeFixture(prefix: string) {
  const root = mkdtempSync(resolve(tmpdir(), `${prefix}-`));
  const sourceRoot = resolve(root, "operator source with spaces");
  mkdirSync(sourceRoot, { recursive: true });
  return { root, sourceRoot };
}

function runCwdReaper(sourceRoot: string, childToken: string, reaperToken: string, cleanUnownedChild = false) {
  const ready = resolve(sourceRoot, "child-ready");
  const script = [
    "set -u",
    reaperFunctions,
    'export PAPERCUSP_TAURI_LAUNCH_PROVENANCE="$TEST_CHILD_TOKEN"',
    '( cd -- "$TEST_SOURCE" || exit 92; : > "$TEST_READY"; exec sleep 60 ) &',
    'child_pid=$!',
    'for attempt in {1..300}; do [ -f "$TEST_READY" ] && break; sleep 0.01; done',
    '[ -f "$TEST_READY" ] || { echo "child did not become ready" >&2; exit 92; }',
    'printf "CHILD_PID=%s\\n" "$child_pid"',
    'export PAPERCUSP_TAURI_LAUNCH_PROVENANCE="$TEST_REAPER_TOKEN"',
    'reap_frozen_source_survivors "$TEST_SOURCE" "$TEST_REAPER_TOKEN"',
    'reap_status=$?',
    'if kill -0 "$child_pid" 2>/dev/null; then child_state=alive; else child_state=exited; fi',
    cleanUnownedChild ? 'if [ "$child_state" = alive ]; then kill -KILL "$child_pid" 2>/dev/null || true; fi' : '',
    'wait "$child_pid"; child_status=$?',
    'printf "CHILD_STATE_AFTER_REAP=%s CHILD_STATUS=%s\\n" "$child_state" "$child_status"',
    'exit "$reap_status"',
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: 25_000,
    env: {
      ...process.env,
      TEST_SOURCE: sourceRoot,
      TEST_READY: ready,
      TEST_CHILD_TOKEN: childToken,
      TEST_REAPER_TOKEN: reaperToken,
    },
  });
}

function generateStopScript(root: string, sourceRoot: string, sourceWork: string, token: string) {
  const work = resolve(root, "work directory");
  mkdirSync(work);
  const setup = [
    "set -euo pipefail",
    'WORK="$TEST_WORK"',
    'TAURI_LAUNCH_PROVENANCE="$TEST_PROVENANCE"',
    'OPERATOR_SOURCE_ROOT="$TEST_SOURCE"',
    'OPERATOR_SOURCE_WORK="$TEST_SOURCE_WORK"',
    'VERIFY_SCOPE_ENABLED=0',
    'VERIFY_SCOPE_BASE="test-scope"',
    'TAURI_SCOPE_UNIT=""',
    'TAURI_PID=""',
    'OPERATOR_HOST_PROCESS_RE="^never-match-this$"',
    'DEV_PORT=0',
    'OPENBOX_PID=""',
    'DISPLAY_NUM=99',
    'ISOLATED_PG_PID=""',
    'ASSERTION_MODE=0',
    'ISOLATED_WEBVIEW_ROOT=""',
    'write_xvfb_stop_script() { printf "#!/usr/bin/env bash\\nexit 0\\n" > "$WORK/stop-xvfb.sh"; chmod +x "$WORK/stop-xvfb.sh"; }',
    spaCleanupFunction,
    reaperFunctions,
    stopFunction,
    "write_frozen_source_reaper_script",
    "write_stop_script",
  ].join("\n");
  const generated = spawnSync("bash", ["-c", setup], {
    encoding: "utf8",
    timeout: 8000,
    env: {
      ...process.env,
      TEST_WORK: work,
      TEST_PROVENANCE: token,
      TEST_SOURCE: sourceRoot,
      TEST_SOURCE_WORK: sourceWork,
    },
  });
  return { work, generated, stopPath: resolve(work, "stop.sh") };
}

describe("verify-tauri-headless frozen-source survivor reaper", () => {
  it("preserves the snapshot when its process census fails", () => {
    const fixture = makeFixture("frozen-source-census-failure");
    try {
      const result = spawnSync("bash", ["-c", [
        "set -u",
        reaperFunctions,
        "frozen_source_rooted_processes() { return 73; }",
        'reap_frozen_source_survivors "$TEST_SOURCE" this-run',
      ].join("\n")], {
        encoding: "utf8", timeout: 8000,
        env: { ...process.env, TEST_SOURCE: fixture.sourceRoot },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("cannot census frozen operator source");
      expect(existsSync(fixture.sourceRoot)).toBe(true);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("accepts a process that exits between the initial liveness and ownership reads", () => {
    const script = [
      'set -u',
      reaperFunctions,
      'sleep 60 &',
      'child=$!',
      'trap \'builtin kill -KILL "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true\' EXIT',
      'ticks="$(frozen_source_process_start_ticks "$child")"',
      'frozen_source_process_owned() {',
      '  frozen_source_process_gone "$1" "$ticks" && return 92',
      '  builtin kill -KILL "$1" 2>/dev/null || return 93',
      '  wait "$1" 2>/dev/null || true',
      '  echo EXIT_DURING_OWNERSHIP >&2',
      '  return 1',
      '}',
      'stop_verify_process "$child" "$ticks" this-run',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8', timeout: 12_000,
      env: { ...process.env, PAPERCUSP_TAURI_LAUNCH_PROVENANCE: 'this-run' },
    });
    expect(result.stderr).toContain('EXIT_DURING_OWNERSHIP');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('VERIFY_PROCESS_UNVERIFIED');
  });

  it("accepts an already exited process without signalling its unreaped zombie", () => {
    const fixture = makeFixture("verify-process-zombie");
    const ready = resolve(fixture.root, "zombie-pid");
    const script = [
      'set -u',
      reaperFunctions,
      'python3 -c \'import os,time; child=os.fork(); (os._exit(0) if child == 0 else None); open(os.environ["TEST_READY"],"w").write(str(child)); time.sleep(60)\' &',
      'parent=$!',
      'trap \'builtin kill -KILL "$parent" 2>/dev/null || true; wait "$parent" 2>/dev/null || true\' EXIT',
      'for attempt in {1..300}; do [ -s "$TEST_READY" ] && break; sleep 0.01; done',
      'child="$(cat "$TEST_READY")"',
      'for attempt in {1..300}; do [ "$(ps -o stat= -p "$child" | cut -c1)" = Z ] && break; sleep 0.01; done',
      '[ "$(ps -o stat= -p "$child" | cut -c1)" = Z ] || exit 92',
      'ticks="$(frozen_source_process_start_ticks "$child")"',
      'kill() { echo UNEXPECTED_SIGNAL >&2; return 1; }',
      'stop_verify_process "$child" "$ticks" this-run',
    ].join('\n');
    try {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8', timeout: 12_000,
        env: { ...process.env, TEST_READY: ready, PAPERCUSP_TAURI_LAUNCH_PROVENANCE: 'this-run' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('UNEXPECTED_SIGNAL');
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each([
    ['pid', 'owned', false, false],
    ['pid', 'foreign', false, true],
    ['pid', 'owned', true, true],
    ['group', 'owned', false, false],
    ['group', 'foreign', false, true],
  ] as const)("guards %s teardown for %s provenance and staleTicks=%s", (kind, ownership, staleTicks, preserved) => {
    const fixture = makeFixture("verify-process-identity");
    const script = [
      "set -u",
      reaperFunctions,
      'setsid sleep 60 &',
      'child=$!',
      'trap \'kill -KILL "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true\' EXIT',
      'for attempt in {1..100}; do [ "$(ps -o comm= -p "$child")" = sleep ] && break; sleep 0.01; done',
      'ticks="$(frozen_source_process_start_ticks "$child")"',
      staleTicks ? 'ticks=1' : '',
      kind === 'group'
        ? 'stop_verify_process_group "$child" this-run'
        : 'stop_verify_process "$child" "$ticks" this-run',
      'status=$?',
      'if kill -0 "$child" 2>/dev/null; then state=alive; else state=exited; fi',
      'printf "STOP_STATUS=%s CHILD_STATE=%s\\n" "$status" "$state"',
    ].join('\n');
    try {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8', timeout: 12_000,
        env: { ...process.env, PAPERCUSP_TAURI_LAUNCH_PROVENANCE: ownership === 'owned' ? 'this-run' : 'another-run' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`STOP_STATUS=${preserved ? 1 : 0} CHILD_STATE=${preserved ? 'alive' : 'exited'}`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("confirms post-KILL exit, refusing cleanup when signals fail=%s", (refuseSignals) => {
    const script = [
      'set -u',
      reaperFunctions,
      'setsid bash -c \'trap "" TERM; exec sleep 60\' &',
      'child=$!',
      'trap \'builtin kill -KILL "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true\' EXIT',
      'for attempt in {1..100}; do [ "$(ps -o comm= -p "$child")" = sleep ] && break; sleep 0.01; done',
      'ticks="$(frozen_source_process_start_ticks "$child")"',
      refuseSignals ? 'kill() { return 1; }' : '',
      'stop_verify_process "$child" "$ticks" this-run',
      'status=$?',
      'if frozen_source_process_gone "$child" "$ticks"; then state=exited; else state=alive; fi',
      'printf "STOP_STATUS=%s CHILD_STATE=%s\\n" "$status" "$state"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8', timeout: 12_000,
      env: { ...process.env, PAPERCUSP_TAURI_LAUNCH_PROVENANCE: 'this-run' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`STOP_STATUS=${refuseSignals ? 1 : 0} CHILD_STATE=${refuseSignals ? 'alive' : 'exited'}`);
    if (refuseSignals) expect(result.stderr).toContain('VERIFY_PROCESS_SURVIVOR');
  });

  it("reaps a run-owned process whose cwd is inside the frozen source", () => {
    const fixture = makeFixture("frozen-source-cwd");
    const token = "test-run-owned-cwd";
    try {
      const result = runCwdReaper(fixture.sourceRoot, token, token);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("ownership=run");
      expect(result.stdout).toMatch(/CHILD_STATE_AFTER_REAP=(alive|exited) CHILD_STATUS=(143|137)/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves the snapshot and leaves an unowned cwd survivor untouched", () => {
    const fixture = makeFixture("frozen-source-unowned");
    try {
      const result = runCwdReaper(fixture.sourceRoot, "different-run", "this-run", true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ownership=unverified; preserving snapshot");
      expect(result.stdout).toContain("CHILD_STATE_AFTER_REAP=alive");
      expect(existsSync(fixture.sourceRoot)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  const hasLinuxPython = process.platform === "linux" && spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!hasLinuxPython)("detects a run-owned mmap reference when cwd is outside the frozen source", () => {
    const fixture = makeFixture("frozen-source-mmap");
    const mappedFile = resolve(fixture.sourceRoot, "mapped file.bin");
    const ready = resolve(fixture.root, "mapping-ready");
    writeFileSync(mappedFile, Buffer.alloc(4096, 65));
    const token = "test-run-owned-mmap";
    const script = [
      "set -u",
      reaperFunctions,
      'export PAPERCUSP_TAURI_LAUNCH_PROVENANCE="$TEST_TOKEN"',
      'python3 -c "$TEST_PYTHON" &',
      'child_pid=$!',
      'for attempt in {1..300}; do [ -f "$TEST_READY" ] && break; sleep 0.01; done',
      '[ -f "$TEST_READY" ] || { echo "mapping process did not become ready" >&2; exit 92; }',
      'reap_frozen_source_survivors "$TEST_SOURCE" "$TEST_TOKEN"',
      'reap_status=$?',
      'wait "$child_pid"; child_status=$?',
      'printf "CHILD_STATUS=%s\\n" "$child_status"',
      'exit "$reap_status"',
    ].join("\n");
    const python = "import mmap,os,time; f=open(os.environ['TEST_MAPPED_FILE'],'rb'); m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ); open(os.environ['TEST_READY'],'w').close(); time.sleep(60)";
    try {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        timeout: 25_000,
        env: {
          ...process.env,
          TEST_SOURCE: fixture.sourceRoot,
          TEST_MAPPED_FILE: mappedFile,
          TEST_READY: ready,
          TEST_TOKEN: token,
          TEST_PYTHON: python,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("ownership=run");
      expect(result.stdout).toMatch(/CHILD_STATUS=(143|137)/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 35_000);

  it.each([
    { directory: "spa", ownership: "run" },
    { directory: "verifier-spa", ownership: "run" },
    { directory: "spa", ownership: "unverified" },
    { directory: "verifier-spa", ownership: "unverified" },
  ])("applies generated stop.sh cleanup to $directory with $ownership survivors", ({ directory, ownership }) => {
    const fixture = makeFixture("frozen-spa-stop");
    const sourceWork = resolve(fixture.root, "source work");
    const sourceRoot = resolve(sourceWork, "operator-source");
    const ready = resolve(fixture.root, "child-ready");
    mkdirSync(sourceRoot, { recursive: true });
    const token = `test-run-spa-stop-${directory}`;
    const generated = generateStopScript(fixture.root, sourceRoot, sourceWork, token);
    const spaRoots = ["spa", "verifier-spa"].map(name => resolve(generated.work, name));
    for (const root of spaRoots) {
      mkdirSync(root);
      writeFileSync(resolve(root, "index.html"), "owned build output");
    }
    const logPath = resolve(generated.work, "verifier.log");
    writeFileSync(logPath, "retained diagnostic evidence");
    const busyRoot = resolve(generated.work, directory);
    const runner = [
      "set -u",
      'export PAPERCUSP_TAURI_LAUNCH_PROVENANCE="$TEST_CHILD_TOKEN"',
      '( cd -- "$TEST_BUSY_ROOT" || exit 92; : > "$TEST_READY"; exec sleep 60 ) &',
      'child_pid=$!',
      'trap \'kill -KILL "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true\' EXIT',
      'for attempt in {1..300}; do [ -f "$TEST_READY" ] && break; sleep 0.01; done',
      '[ -f "$TEST_READY" ] || { echo "child did not become ready" >&2; exit 92; }',
      'bash "$TEST_STOP"',
      'stop_status=$?',
      'child_state="$(ps -o stat= -p "$child_pid" 2>/dev/null)"',
      'case "$child_state" in ""|Z*) echo CHILD_AFTER_STOP=exited ;; *) echo CHILD_AFTER_STOP=alive ;; esac',
      'exit "$stop_status"',
    ].join("\n");
    try {
      expect(generated.generated.status, generated.generated.stderr).toBe(0);
      const result = spawnSync("bash", ["-c", runner], {
        encoding: "utf8",
        timeout: 25_000,
        env: {
          ...process.env,
          TEST_CHILD_TOKEN: ownership === "run" ? token : `${token}-other`,
          TEST_BUSY_ROOT: busyRoot,
          TEST_READY: ready,
          TEST_STOP: generated.stopPath,
        },
      });
      if (ownership === "run") {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("CHILD_AFTER_STOP=exited");
        for (const root of spaRoots) expect(existsSync(root), root).toBe(false);
        expect(existsSync(sourceWork)).toBe(false);
      } else {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("ownership=unverified; preserving snapshot");
        expect(result.stdout).toContain("CHILD_AFTER_STOP=alive");
        expect(existsSync(busyRoot)).toBe(true);
        expect(existsSync(sourceWork)).toBe(true);
      }
      expect(readFileSync(logPath, "utf8")).toBe("retained diagnostic evidence");
      expect(existsSync(resolve(generated.work, "frozen-source-reaper.sh"))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 35_000);

  it("loads the persisted reaper from generated stop.sh and removes the owned snapshot", () => {
    const fixture = makeFixture("frozen-source-stop");
    const sourceWork = resolve(fixture.root, "source work");
    const sourceRoot = resolve(sourceWork, "operator-source");
    const ready = resolve(fixture.root, "child-ready");
    mkdirSync(sourceRoot, { recursive: true });
    const token = "test-run-owned-stop";
    const generated = generateStopScript(fixture.root, sourceRoot, sourceWork, token);
    try {
      expect(generated.generated.status, generated.generated.stderr).toBe(0);
      const stopText = readFileSync(generated.stopPath, "utf8");
      expect(stopText).toContain(`source "${generated.work}/frozen-source-reaper.sh"`);
      expect(stopText).toContain("reap_frozen_source_survivors");
      expect(existsSync(resolve(generated.work, "frozen-source-reaper.sh"))).toBe(true);
      const runner = [
        "set -u",
        'export PAPERCUSP_TAURI_LAUNCH_PROVENANCE="$TEST_TOKEN"',
        '( cd -- "$TEST_SOURCE" || exit 92; : > "$TEST_READY"; exec sleep 60 ) &',
        'for attempt in {1..300}; do [ -f "$TEST_READY" ] && break; sleep 0.01; done',
        '[ -f "$TEST_READY" ] || { echo "child did not become ready" >&2; exit 92; }',
        'source "$TEST_STOP"',
      ].join("\n");
      const result = spawnSync("bash", ["-c", runner], {
        encoding: "utf8",
        timeout: 25_000,
        env: {
          ...process.env,
          TEST_TOKEN: token,
          TEST_SOURCE: sourceRoot,
          TEST_SOURCE_WORK: sourceWork,
          TEST_READY: ready,
          TEST_STOP: generated.stopPath,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(sourceWork)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 35_000);
});

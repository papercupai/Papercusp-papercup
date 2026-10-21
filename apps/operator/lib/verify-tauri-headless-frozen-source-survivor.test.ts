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

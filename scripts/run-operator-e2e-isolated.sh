#!/usr/bin/env bash
# Run the operator Playwright suite inside the isolated verify-tauri-headless rig and keep
# its per-file results in the SHARED test_runs ledger.
# (WI-10006736; plan operator-e2e-standing-isolated-run-2026-10-06, P-001.)
#
# Usage: scripts/run-operator-e2e-isolated.sh [playwright test args...]
#   No args runs the whole default-config suite. Extra args are forwarded to
#   `playwright test` (spec filters, --grep, --workers, ...). `--reporter` is refused:
#   a CLI reporter REPLACES the config's reporters, which disables the ledger reporter
#   (EI-25232220211651248).
#
# Exit code: Playwright's own code. 2 = refused argument. A rig boot failure passes its
# own non-zero code through unchanged.
#
# Why the ledger URL is resolved HERE: with VERIFY_TAURI_ISOLATED_DB=1 the rig exports
# HARNESS_ADMIN_DATABASE_URL pointing at its throwaway database before it runs the
# assertion command. The ledger reporters resolve PAPERCUSP_TEST_RUNS_DB_URL first, so
# pinning it to the shared ledger before entering the rig keeps the results; without it
# every isolated result is written into the throwaway database and destroyed at teardown
# (measured 2026-10-06 17:13Z: a 37-pass run left no shared rows). The app under test
# still sees the isolated HARNESS_ADMIN_DATABASE_URL, so isolation is unchanged.
#
# Env:
#   PAPERCUSP_TEST_RUNS_DB_URL  shared ledger; default = the caller's
#                               HARNESS_ADMIN_DATABASE_URL, else the operator default.
#   PAPERCUSP_TEST_RUN_GROUP    run group stamped on every row; default
#                               operator-e2e-isolated-<utc>-<pid>.
#   OPERATOR_E2E_RIG            rig command (default scripts/verify-tauri-headless.sh).
#   OPERATOR_E2E_PLAYWRIGHT     playwright command (default "npx playwright test").
#   OPERATOR_E2E_NETNS_WRAPPER  network-namespace wrapper Playwright runs under (default
#                               scripts/lib/run-in-isolated-netns.sh). It keeps host
#                               interface churn from aborting Chromium loads with
#                               net::ERR_NETWORK_CHANGED (WI-6554700010008480);
#                               PAPERCUSP_E2E_NETNS=auto|required|off selects its mode.
#   VERIFY_TAURI_SOURCE_REF     committed source ref; defaults to HEAD. Set it
#                               explicitly empty to keep the guarded working-tree mode.
#   VERIFY_TAURI_SOURCE_INPUTS[_FILE]
#                               acceptance paths checked against the ref; when omitted,
#                               the runner records the Playwright config and direct spec paths.
#   The rig exports OPERATOR_SOURCE_ROOT at its assertion boundary; Vite and
#   Playwright both execute from that frozen source. Legacy/test rigs without
#   a source snapshot keep the caller checkout.
#   VH_PHASE_DIR is exported by the rig at the assertion boundary. The runner
#   retains Vite/Playwright logs and failed screenshots, video and traces there;
#   its Playwright output/trace options override caller options for that run.
#   The last two are test seams (apps/operator/lib/__tests__/e2e-isolated-runner.test.ts).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
source "$ROOT/libs/generic/verification-harness/bin/vh.sh"

# The task reconciler recovers a lost managed-task watcher from this terminal
# marker. Register it before vh_bracket_trap so the harness finalizer runs first
# and the durable task outcome is the last line emitted on every shell exit.
write_task_terminal_marker() {
  local rc=$?
  local status=completed
  if [ "$rc" -ne 0 ]; then status=failed; fi
  printf '[capability:bash] JOB END: status=%s exit=%s at %s\n' \
    "$status" "$rc" "$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
}
trap 'write_task_terminal_marker' EXIT

# The native Inbox acknowledgement acceptance drives a post-onboarding route,
# and writes a full JSON receipt separately from the reporter's JSONL ledger
# receipts. Refuse a misconfigured or stale receipt before harness initialization
# or the desktop boot.
native_preflight_args=("$@")
# The default suite includes this native acceptance too. An empty filter must
# not bypass prerequisites that an explicitly selected spec enforces.
has_explicit_spec=0
for arg in "$@"; do
  case "$arg" in
    *.spec.*|*.test.*|*.live.*) has_explicit_spec=1 ;;
  esac
done
if [ "$has_explicit_spec" -eq 0 ]; then
  native_preflight_args=(e2e/inbox-ack-persistence.native.spec.mts e2e/support-workflow-native.spec.mts)
fi
for arg in "${native_preflight_args[@]}"; do
  case "$arg" in
    *support-workflow-native.spec.mts*)
      # A receipt is admission, not a prepared worker result. Placement runs
      # in the routines tick; a request-only desktop can never complete this
      # journey. Reuse the launcher's isolated-only worker opt-in.
      if [ "${VERIFY_TAURI_ISOLATED_SEED:-}" != "ready" ] || [ "${PAPERCUSP_DEV_BACKGROUND_WORKERS:-}" != "1" ]; then
        echo "run-operator-e2e-isolated: support-workflow-native.spec.mts requires VERIFY_TAURI_ISOLATED_SEED=ready and PAPERCUSP_DEV_BACKGROUND_WORKERS=1 (isolated worker placement)" >&2
        exit 2
      fi
      ;;
    *inbox-ack-persistence.native.spec.mts*)
      if [ "${VERIFY_TAURI_ISOLATED_SEED:-}" != "ready" ]; then
        echo "run-operator-e2e-isolated: inbox-ack-persistence.native.spec.mts requires VERIFY_TAURI_ISOLATED_SEED=ready" >&2
        exit 2
      fi
      if [ -z "${PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE:-}" ]; then
        echo "run-operator-e2e-isolated: set PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE to a fresh acceptance-receipt path" >&2
        exit 2
      fi
      case "$PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE" in
        /*) ;;
        *)
          echo "run-operator-e2e-isolated: PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE must be absolute" >&2
          exit 2
          ;;
      esac
      if [ -z "${PAPERCUSP_TEST_RUN_RECEIPT_FILE:-}" ]; then
        echo "run-operator-e2e-isolated: set PAPERCUSP_TEST_RUN_RECEIPT_FILE for the test-run reporter" >&2
        exit 2
      fi
      if [ "$PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE" = "$PAPERCUSP_TEST_RUN_RECEIPT_FILE" ]; then
        echo "run-operator-e2e-isolated: acceptance and test-run reporter receipts must use separate paths" >&2
        exit 2
      fi
      if [ -e "$PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE" ]; then
        echo "run-operator-e2e-isolated: refusing to overwrite existing acceptance receipt: $PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE" >&2
        exit 2
      fi
      ;;
  esac
done

# Declare the bracket phases before initialization so a failed contract can
# record them as blocked and, more importantly, cannot fall through to the rig.
vh_phase preflight ""
vh_phase isolated-suite preflight
vh_init operator-e2e-isolated "${OPERATOR_E2E_HARNESS_EVIDENCE_ROOT:-/tmp/pcv/operator-e2e-isolated}"
vh_init_rc=$?
if [ "$vh_init_rc" -ne 0 ]; then
  echo "run-operator-e2e-isolated: verification harness initialization failed (rc=$vh_init_rc); refusing native rig" >&2
  exit "$vh_init_rc"
fi
vh_bracket_trap
vh_begin preflight
DEFAULT_LEDGER_URL='postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp'

for arg in "$@"; do
  case "$arg" in
    --reporter | --reporter=*)
      echo "run-operator-e2e-isolated: refusing '$arg': a CLI reporter replaces the config reporters and disables the test_runs ledger reporter (EI-25232220211651248)" >&2
      exit 2
      ;;
  esac
done

export PAPERCUSP_TEST_RUNS_DB_URL="${PAPERCUSP_TEST_RUNS_DB_URL:-${HARNESS_ADMIN_DATABASE_URL:-$DEFAULT_LEDGER_URL}}"
export PAPERCUSP_TEST_RUN_GROUP="${PAPERCUSP_TEST_RUN_GROUP:-operator-e2e-isolated-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
# Ledger identity, pinned from the CALLER before the rig rebinds PAPERCUSP_WORKSPACE_ID to
# its throwaway verify-tauri-isolated-<display> workspace. The reporters resolve these
# ledger-only overrides first (resolveTestRunWorkspaceId / resolveTestRunHarnessSlug), so
# rows stay readable by workspace-scoped consumers; the app still sees the isolated ids.
# This suite is the papercusp harness's own, hence that harness default.
export PAPERCUSP_TEST_RUN_HARNESS="${PAPERCUSP_TEST_RUN_HARNESS:-${HARNESS_SLUG:-${PAPERCUSP_HARNESS_SLUG:-papercusp}}}"
PAPERCUSP_TEST_RUN_WORKSPACE="${PAPERCUSP_TEST_RUN_WORKSPACE:-${PAPERCUSP_WORKSPACE_ID:-${PAPERCUSP_WORKSPACE:-}}}"
if [ -n "$PAPERCUSP_TEST_RUN_WORKSPACE" ]; then
  export PAPERCUSP_TEST_RUN_WORKSPACE
else
  unset PAPERCUSP_TEST_RUN_WORKSPACE
  echo "run-operator-e2e-isolated: WARNING no caller workspace (PAPERCUSP_TEST_RUN_WORKSPACE / PAPERCUSP_WORKSPACE_ID / PAPERCUSP_WORKSPACE); ledger rows will carry the rig's throwaway workspace id" >&2
fi
export OPERATOR_E2E_PLAYWRIGHT="${OPERATOR_E2E_PLAYWRIGHT:-npx playwright test}"
export OPERATOR_E2E_NETNS_WRAPPER="${OPERATOR_E2E_NETNS_WRAPPER:-$ROOT/scripts/lib/run-in-isolated-netns.sh}"
# The native host handles agent chat; setting this only on Vite leaves the
# backend using live credentials and makes fake-LLM-only cases skip.
export PAPERCUSP_FAKE_LLM=1
# Open signup for THIS throwaway rig operator only (WI-10006791). The rig always has
# its auto-signed-in default user, and /api/auth/signup refuses 403 signup_disabled
# whenever a user exists and papercusp-open-signup is off. That flag is an
# owner-authority DARK flag (internet-reachable signup), so it must never be flipped
# globally; the per-process env override reaches only the isolated rig's operator,
# which is what the ui-flow-login-prefs signup specs need. A caller may pass 0.
export PAPERCUSP_FLAG_PAPERCUSP_OPEN_SIGNUP="${PAPERCUSP_FLAG_PAPERCUSP_OPEN_SIGNUP:-1}"
# A caller-level opt-out would make the whole run evidence-free; the runner exists to record.
unset PAPERCUSP_DISABLE_TEST_RUNS_REPORTER
RIG="${OPERATOR_E2E_RIG:-$ROOT/scripts/verify-tauri-headless.sh}"

# The standing isolated runner verifies an immutable commit by default. Resolve every
# non-empty selector to its commit id here: downstream source receipts bind to that id,
# not a symbolic ref such as HEAD or a branch name. The verifier's working-tree mode
# intentionally refuses any active source lock because it copies the whole repository;
# callers can explicitly set VERIFY_TAURI_SOURCE_REF empty to request that mode when they
# need uncommitted source.
if [ "${VERIFY_TAURI_SOURCE_REF+x}" != "x" ]; then
  VERIFY_TAURI_SOURCE_REF=HEAD
fi
if [ -n "${VERIFY_TAURI_SOURCE_REF:-}" ]; then
  source_ref="$VERIFY_TAURI_SOURCE_REF"
  VERIFY_TAURI_SOURCE_REF="$(git -C "$ROOT" rev-parse --verify --end-of-options "${source_ref}^{commit}")" || {
    echo "run-operator-e2e-isolated: could not resolve committed source ref: $source_ref" >&2
    exit 2
  }
  [ -n "$VERIFY_TAURI_SOURCE_REF" ] || {
    echo "run-operator-e2e-isolated: committed source ref resolved empty: $source_ref" >&2
    exit 2
  }
  export VERIFY_TAURI_SOURCE_REF
fi

# Bind the pin to the suite config and any direct Playwright spec-file filters. The
# committed archive still contains the full source tree; these paths are its checked
# acceptance inputs. Keep them in the run evidence instead of a comma-delimited argv.
if [ -n "${VERIFY_TAURI_SOURCE_REF:-}" ] && [ -z "${VERIFY_TAURI_SOURCE_INPUTS:-}${VERIFY_TAURI_SOURCE_INPUTS_FILE:-}" ]; then
  [ -n "${VH_RUN_DIR:-}" ] || {
    echo "run-operator-e2e-isolated: verification harness did not provide a run directory for source inputs" >&2
    exit 2
  }
  VERIFY_TAURI_SOURCE_INPUTS_FILE="$VH_RUN_DIR/operator-e2e-source-inputs.json"
  export VERIFY_TAURI_SOURCE_INPUTS_FILE
  node --input-type=module - "$ROOT" "$@" > "$VERIFY_TAURI_SOURCE_INPUTS_FILE" <<'NODE'
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const repoRoot = resolve(process.argv[2]);
const operatorRoot = resolve(repoRoot, 'apps/operator');
const inputs = new Set(['apps/operator/playwright.config.mts', 'apps/operator/playwright.config.ts']);
const specPath = /\.(?:spec|test|live)\.[cm]?[jt]sx?$/i;
const valueOptions = new Set([
  '--grep', '-g', '--grep-invert', '--project', '-p', '--workers', '-j',
  '--timeout', '--global-timeout', '--retries', '--repeat-each', '--output', '-o',
  '--shard', '--test-dir', '--test-match', '--test-ignore', '--tsconfig',
]);

function addFile(raw, label) {
  const path = raw.replace(/(?::\d+)+$/, '');
  const absolute = isAbsolute(path)
    ? resolve(path)
    : path === 'apps/operator' || path.startsWith('apps/operator/')
      ? resolve(repoRoot, path)
      : resolve(operatorRoot, path);
  const repoPath = relative(repoRoot, absolute).split(sep).join('/');
  if (repoPath === '..' || repoPath.startsWith('../') || isAbsolute(repoPath)) {
    console.error('run-operator-e2e-isolated: ' + label + ' must be inside the repository: ' + raw);
    process.exit(2);
  }
  let isFile = false;
  try { isFile = statSync(absolute).isFile(); } catch {}
  if (!existsSync(absolute) || !isFile) {
    console.error('run-operator-e2e-isolated: ' + label + ' is not a regular file: ' + raw);
    process.exit(2);
  }
  inputs.add(repoPath);
}

const args = process.argv.slice(3);
// An unfiltered run executes native journeys too. Their original source
// receipts must name the specs and fixtures, rather than just the configs.
if (!args.some(arg => !arg.startsWith('-') && specPath.test(arg.replace(/(?::\d+)+$/, '')))) {
  for (const name of readdirSync(resolve(operatorRoot, 'e2e'), { recursive: true })) {
    if (/\.[cm]?[jt]sx?$/i.test(name)) addFile('e2e/' + name, 'default-suite input');
  }
}
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--config' || arg === '-c') {
    if (args[i + 1]) addFile(args[++i], 'Playwright config');
    continue;
  }
  if (arg.startsWith('--config=')) {
    addFile(arg.slice('--config='.length), 'Playwright config');
    continue;
  }
  if (valueOptions.has(arg)) {
    i++;
    continue;
  }
  if (arg.startsWith('-') || !specPath.test(arg.replace(/(?::\d+)+$/, ''))) continue;
  addFile(arg, 'Playwright spec');
}

if (inputs.has('apps/operator/e2e/inbox-ack-persistence.native.spec.mts')) {
  addFile('app/_components/inbox/use-inbox-pending.ts', 'native Inbox input');
  addFile('app/admin/plans/plans-api.ts', 'native Inbox input');
}
if (inputs.has('apps/operator/e2e/ticket-integrations.native.spec.mts')) {
  addFile('apps/operator/e2e/_ongoing-work-native-fixture.ts', 'native custody helper');
  addFile(resolve(repoRoot, 'scripts/tauri-surface-verify-ticket-integrations.sh'), 'native ticket assertion');
}

process.stdout.write(JSON.stringify([...inputs].sort()) + '\n');
NODE
  source_inputs_status=$?
  if [ "$source_inputs_status" -ne 0 ]; then
    rm -f -- "$VERIFY_TAURI_SOURCE_INPUTS_FILE"
    exit "$source_inputs_status"
  fi
fi

# Native acceptance consumers also inspect the inline custody list. Derive it
# from the same file used by admission so both representations name the same inputs.
if [ -z "${VERIFY_TAURI_SOURCE_INPUTS:-}" ] && [ -n "${VERIFY_TAURI_SOURCE_INPUTS_FILE:-}" ]; then
  VERIFY_TAURI_SOURCE_INPUTS="$(node -e 'const fs = require("node:fs"); const paths = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!Array.isArray(paths) || paths.some(p => typeof p !== "string" || /[\s,]/.test(p))) process.exit(2); process.stdout.write(paths.join(","));' "$VERIFY_TAURI_SOURCE_INPUTS_FILE")" || exit $?
  export VERIFY_TAURI_SOURCE_INPUTS
fi

# Refuse stale acceptance inputs before the rig allocates native build slots or
# runs platform preparation. Include the same mandatory tooling profile as the
# rig; the rig rechecks after export to protect against racing edits.
if [ -n "${VERIFY_TAURI_SOURCE_REF:-}" ] && [ -n "${VERIFY_TAURI_SOURCE_INPUTS:-}${VERIFY_TAURI_SOURCE_INPUTS_FILE:-}" ]; then
  input_check_args=(--repo "$ROOT" --ref "$VERIFY_TAURI_SOURCE_REF" --tauri-inputs)
  if [ -n "${VERIFY_TAURI_SOURCE_INPUTS:-}" ]; then
    input_check_args+=(--inputs "$VERIFY_TAURI_SOURCE_INPUTS")
  fi
  if [ -n "${VERIFY_TAURI_SOURCE_INPUTS_FILE:-}" ]; then
    input_check_args+=(--inputs-file "$VERIFY_TAURI_SOURCE_INPUTS_FILE")
  fi
  node "$ROOT/scripts/source-preview.mjs" verifier-inputs-check "${input_check_args[@]}" || exit $?
fi

# Collect with the SAME selection arguments before allocating native build/DB
# resources. Playwright --grep sees project + filename + title, so an apparently
# valid anchored title can select nothing. Collection never runs fixtures and
# uses its own JSON reporter; execution keeps the config's ledger reporters.
selection_report="$VH_PHASE_DIR/selection.json"
selection_stdout="$VH_PHASE_DIR/selection.stdout.log"
selection_errors="$VH_PHASE_DIR/selection.stderr.log"
(
  cd "$ROOT/apps/operator" || exit 2
  PLAYWRIGHT_JSON_OUTPUT_FILE="$selection_report" timeout --signal=TERM --kill-after=5s 60s bash -c \
    'exec $OPERATOR_E2E_PLAYWRIGHT "$@" --list --reporter=json' -- "$@"
) >"$selection_stdout" 2>"$selection_errors"
selection_status=$?
if [ "$selection_status" -ne 0 ]; then
  vh_fail selection-collection-failed
  tail -n 20 "$selection_stdout" >&2
  tail -n 20 "$selection_errors" >&2
  echo "run-operator-e2e-isolated: selection collection failed (rc=$selection_status); refusing native rig; evidence=$selection_report" >&2
  exit 2
fi
node --input-type=module - "$selection_report" <<'JS'
import fs from 'node:fs';
const file = process.argv[2];
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const selected = [];
function visit(suites, parents = []) {
  for (const suite of suites ?? []) {
    const titles = [...parents, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) selected.push({
        project: test.projectName, title: [...titles, spec.title].join(' › '),
      });
    }
    visit(suite.suites, titles);
  }
}
visit(report.suites);
if (report.errors?.length || !selected.length) {
  console.error('run-operator-e2e-isolated: empty or invalid selection; refusing native rig');
  process.exit(2);
}
fs.writeFileSync(file.replace(/\.json$/, '-proof.json'), JSON.stringify({
  sourceRef: process.env.VERIFY_TAURI_SOURCE_REF ?? null, count: selected.length, selected,
}, null, 2) + '\n');
console.log(`OPERATOR_E2E_SELECTION count=${selected.length} report=${file}`);
JS
selection_status=$?
if [ "$selection_status" -ne 0 ]; then
  vh_fail selection-invalid
  echo "run-operator-e2e-isolated: invalid selection report; refusing native rig; evidence=$selection_report" >&2
  exit 2
fi

echo "OPERATOR_E2E_ISOLATED group=$PAPERCUSP_TEST_RUN_GROUP ledger=${PAPERCUSP_TEST_RUNS_DB_URL##*@} workspace=${PAPERCUSP_TEST_RUN_WORKSPACE:-<rig>} harness=$PAPERCUSP_TEST_RUN_HARNESS rig=$RIG"

rig_pid=""
interrupt_suite() {
  local rc="$1"
  vh_fail "interrupted:exit-$rc"
  trap - INT TERM HUP
  if [ -n "$rig_pid" ]; then
    # The rig owns native-process cleanup. TERM requests that cleanup even
    # for INT: asynchronous bash children inherit an ignored SIGINT.
    kill -TERM "$rig_pid" 2>/dev/null || true
    wait "$rig_pid" 2>/dev/null || true
    rig_pid=""
  fi
  # A signal's default EXIT trap can see the previous command's zero status.
  # Preserve the interruption explicitly so an unfinished suite cannot pass.
  exit "$rc"
}
trap 'interrupt_suite 130' INT
trap 'interrupt_suite 143' TERM
trap 'interrupt_suite 129' HUP

vh_begin isolated-suite
# Bash runs EXIT traps for some unhandled signals with the previous command's
# zero status. A suite is incomplete until wait returns normally; a zero EXIT
# status alone cannot prove that the owned rig finished (EI-25624952711525720).
vh_fail isolated-suite-incomplete
# shellcheck disable=SC2016 # expanded by the inner shell, inside the rig
# File-backed assertions use the rig's existing immutable script snapshot.
# Keep orchestration out of its intentionally small inline-command grammar.
VERIFY_TAURI_ISOLATED_DB=1 "$RIG" -- bash "$ROOT/scripts/lib/operator-e2e-assertion.sh" "$@" &
rig_pid=$!
wait "$rig_pid"
rc=$?
rig_pid=""
vh_fail ""
echo "OPERATOR_E2E_ISOLATED exit=$rc group=$PAPERCUSP_TEST_RUN_GROUP"
exit "$rc"

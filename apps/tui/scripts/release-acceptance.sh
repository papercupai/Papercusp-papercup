#!/usr/bin/env bash
# The installed-TUI release stage (pui-first-party-public-release P-012 / D-018).
#
# Installs one candidate archive from apps/tui/scripts/package-release.sh into a
# clean HOME, drives the production-operator PTY suites through that installed
# bin/pui, and writes <archive>.acceptance.json. An archive may be published
# (P-014/P-015) only with a passing acceptance file for the same digest.
#
# Isolation (EI-24692155752067316). The stage runs tsx, vitest, the suites and
# the operator fixture from the checkout it executes in. Run from the shared
# working tree, a peer's half-written edit lands in the run: rehearsal
# 37bc2d4c32 lost its claude leg to a transient scripts/next-migration.js and
# its omp leg to a mid-edit syntax error in gateway.ts, neither of them PUI code.
# So this script checks out the archive's own source commit (PROVENANCE.json
# source.commit) with the release checkout helper, object-sourced and with
# node_modules captured under the maintained install-reader lock into an
# independent immutable generation, and runs
# the stage from there. Up to three reusable
# checkouts live under PUI_ACCEPTANCE_CHECKOUT_ROOT (default
# ~/.cache/pui-acceptance-checkouts) and are re-pinned on each use.
# PUI_ACCEPTANCE_ALLOW_LIVE_TREE=1 runs in place instead, for development only:
# the verdict then refuses (release-acceptance-run.ts runnerTreeRefusals).
#
# Exit 0 = accepted, 1 = refused (the file names every reason), 2 = could not run.
# --help prints the options. Setup output goes to stderr; stdout carries only
# the stage's own PUI_RELEASE_ACCEPTANCE line.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
run_in() {
  local root="$1"; shift
  exec "$root/node_modules/.bin/tsx" "$root/packages/operator-core/lib/pui-e2e/release-acceptance-cli.mts" "$@"
}
fail() { echo "release-acceptance: ERROR: $*" >&2; exit 2; }

# Resolve the admin authority in the shared caller before materializing the
# immutable candidate checkout. The checkout's source is deliberately frozen,
# but its test-runs/disclosure-ledger reporter still needs the caller's actual
# database credentials; without this pin, the candidate can fall through to a
# stale discovery/default URL and refuse before any product test starts.
preflight_acceptance_database() {
  local resolved
  resolved="$(node --input-type=module - "$ROOT" <<'NODE'
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const deadline = setTimeout(() => {
  console.error('release-acceptance: database preflight exceeded 15000ms');
  process.exit(1);
}, 15_000);
let client;
try {
  const root = process.argv[2];
  const { resolveScriptPgUrl, describePgUrlResolution } = await import(pathToFileURL(root + '/scripts/lib/pg-url.mjs').href);
  const resolution = resolveScriptPgUrl();
  console.error('release-acceptance: ' + describePgUrlResolution(resolution));
  const { Client } = createRequire(root + '/package.json')('pg');
  client = new Client({ connectionString: resolution.url, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000 });
  await client.connect();
  await client.query('SELECT 1');
  await client.end();
  client = undefined;
  process.stdout.write(resolution.url);
} catch (error) {
  // A malformed DSN or driver error may contain credentials. Report only a
  // bounded machine code; the resolver diagnostic above already names the host.
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/i.test(error.code) ? error.code : 'failed';
  console.error('release-acceptance: database authentication/read preflight ' + code);
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
  clearTimeout(deadline);
}
NODE
)" || fail 'disclosure-ledger database preflight failed before candidate checkout'
  [ -n "$resolved" ] || fail 'database resolver returned an empty HARNESS_ADMIN_DATABASE_URL'
  export HARNESS_ADMIN_DATABASE_URL="$resolved"
}

# Retire only explicitly named rebuildable dependencies of an idle slot. Source,
# archives and acceptance evidence stay in place; normal preparation restores
# these trees from its required immutable generation on the next use.
if [ "${1:-}" = --retire-dependencies ]; then
  shift
  slot="${1:-}"; expected="${2:-}"; shift 2 || fail 'retirement needs slot and exact source commit'
  [[ "$slot" =~ ^[123]$ ]] || fail 'retirement slot must be 1, 2 or 3'
  [[ "$expected" =~ ^[0-9a-f]{40}$ ]] || fail 'retirement needs the exact source commit'
  checkouts="${PUI_ACCEPTANCE_CHECKOUT_ROOT:-$HOME/.cache/pui-acceptance-checkouts}"
  [ -d "$checkouts" ] || fail "no acceptance cache at $checkouts"
  checkouts="$(cd "$checkouts" && pwd -P)"
  [ ! -L "$checkouts/slot-$slot.lock" ] || fail 'slot lock cannot be a symlink'
  exec 9>"$checkouts/slot-$slot.lock"
  flock -n 9 || fail "slot $slot is held"
  exec "$ROOT/node_modules/.bin/tsx" "$ROOT/packages/operator-core/lib/pui-e2e/release-acceptance-cache.ts" \
    "$checkouts/slot-$slot" "$expected" "$@"
fi

archive=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --archive) archive="${args[i + 1]:-}" ;;
    --archive=*) archive="${args[i]#--archive=}" ;;
    -h|--help) run_in "$ROOT" "$@" ;;
  esac
done
# No archive: the CLI prints its usage. Already re-executed, or opted out: run here.
if [ -z "$archive" ] || [ -n "${PUI_ACCEPTANCE_ISOLATED:-}" ] || [ "${PUI_ACCEPTANCE_ALLOW_LIVE_TREE:-}" = 1 ]; then
  run_in "$ROOT" "$@"
fi

[ -f "$archive" ] || fail "no archive at $archive"
provenance="$(tar -xzOf "$archive" --wildcards --no-wildcards-match-slash '*/PROVENANCE.json')" \
  || fail "$archive carries no top-level PROVENANCE.json"
sha="$(printf '%s' "$provenance" | node -e '
  let text = "";
  process.stdin.on("data", (chunk) => { text += chunk; }).on("end", () => {
    const commit = JSON.parse(text).source?.commit ?? "";
    if (!/^[0-9a-f]{40}$/.test(commit)) process.exit(1);
    process.stdout.write(commit);
  });')" || fail "$archive PROVENANCE.json has no 40-hex source.commit"

preflight_acceptance_database

checkouts="${PUI_ACCEPTANCE_CHECKOUT_ROOT:-$HOME/.cache/pui-acceptance-checkouts}"
mkdir -p "$checkouts"
checkouts="$(cd "$checkouts" && pwd -P)"
# A few reusable slots, each re-pinned per run: bounded disk, and a re-pin moves
# only what changed. One run per slot, since a second would re-pin the tree
# under the first. The lock is held by this process and everything it execs; a
# leftover child of an earlier run holds it too (`fuser -v <slot>.lock`).
checkout=""
for slot in 1 2 3; do
  # Offload-backed caches can retain legacy symlinked slots. The cleanup helper
  # correctly refuses those aliases; skip them here and use another physical
  # slot instead of aborting before the acceptance stage starts.
  if [ -L "$checkouts/slot-$slot" ]; then
    echo "release-acceptance: skipping symlinked checkout slot $slot" >&2
    continue
  fi
  exec 9>"$checkouts/slot-$slot.lock"
  if flock -n 9; then checkout="$checkouts/slot-$slot"; break; fi
  exec 9>&-
done
[ -n "$checkout" ] || fail "no free physical acceptance slot under $checkouts (all three slots are held or nonphysical)"

# A killed prior parent may have missed its EXIT cleanup. Clear that slot's
# verified, idle copies before admission, so an otherwise admissible retry is
# not blocked by the previous attempt's retained bytes.
if [ -d "$checkout" ]; then
  cached_sha="$(git -C "$checkout" rev-parse HEAD)" || fail "cannot verify cached source at $checkout"
  "$ROOT/node_modules/.bin/tsx" "$ROOT/packages/operator-core/lib/pui-e2e/release-acceptance-cache.ts" \
    "$checkout" "$cached_sha" --all-dependencies --execute >&2 \
    || fail "cached-slot dependency retirement refused at $checkout"
fi

echo "release-acceptance: checking out candidate source $sha at $checkout" >&2
# Freeze the shared helper and its adjacent sidecars before its long checkout
# work. Bash reads scripts lazily; a peer edit during materialization must not
# change the program this invocation is executing.
# Keep immutable dependency generations in the acceptance cache. Each slot
# consumes a validated donor while the shared integration tree may change.
# Use the maintained install-reader boundary throughout capture/materialization.
node "$ROOT/scripts/npm-install-safe.mjs" --repo-root "$ROOT" --exec-under-lock -- \
  bash "$ROOT/apps/operator/scripts/systemd/papercusp-script-snapshot.sh" \
  "$ROOT/apps/operator/bin/release/setup-release-checkout.sh" \
  --ref "$sha" --integration "$ROOT" --release "$checkout" \
  --node-modules force --node-modules-copy copy --node-modules-generation required \
  --dependency-generation-root "$checkouts/dependency-generations" \
  --source-integrity object-sourced >&2 \
  || fail "could not check out $sha at $checkout (setup-release-checkout.sh failed; output above)"
landed="$(git -C "$checkout" rev-parse HEAD)"
[ "$landed" = "$sha" ] || fail "checkout $checkout is at $landed, not the candidate source $sha"

export PUI_ACCEPTANCE_ISOLATED="$checkout"
# A bounded slot count does not bound its retained physical dependency copies.
# Retire these after every completed attempt, including a refused verdict. Source,
# archives and receipts stay intact; the next preparation restores dependencies.
# Keep fd 9 locked until the retirement helper has verified no child still uses
# the slot. A refused cleanup is visible and cannot turn into a successful run.
retire_completed_slot() {
  local run_status=$? cleanup_status=0
  trap - EXIT
  "$ROOT/node_modules/.bin/tsx" "$ROOT/packages/operator-core/lib/pui-e2e/release-acceptance-cache.ts" \
    "$checkout" "$sha" --all-dependencies --execute >&2 || cleanup_status=$?
  if [ "$cleanup_status" -ne 0 ]; then
    echo "release-acceptance: ERROR: completed-slot dependency retirement refused (run=$run_status cleanup=$cleanup_status); source and evidence retained" >&2
    [ "$run_status" -ne 0 ] || run_status=2
  fi
  exit "$run_status"
}
trap retire_completed_slot EXIT
"$checkout/node_modules/.bin/tsx" "$checkout/packages/operator-core/lib/pui-e2e/release-acceptance-cli.mts" "$@"

#!/usr/bin/env bash
# Isolated desktop acceptance for linear-asana-task-sync-2026-10-05 P-007 (WI-10006367):
# Settings → Integrations lists every registered ticket provider as connectable, a ticket source
# appears and updates live, its config writes through the real route, and /admin/admission shows
# the same source with a link back to its settings.
#
# Run only through scripts/verify-tauri-headless.sh with an isolated DB (it inserts a data source
# and writes its config, so it must never touch the owner's real rows):
#
#   VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='Ticket sources' \
#     scripts/verify-tauri-headless.sh -- bash scripts/tauri-surface-verify-ticket-integrations.sh
#
# Registered as the `ticket-integrations` leg of scripts/tauri-surface-verify-suite.sh, which the
# daily gui-e2e-surface scheduled run executes. Emits the suite's per-leg contract line
# `P007_TAURI_SURFACE_VERIFY_(OK|FAIL) leg=ticket-integrations output=<dir>`.
set -uo pipefail

: "${VERIFY_TAURI_PID:?missing VERIFY_TAURI_PID — run via scripts/verify-tauri-headless.sh}"

LEG=ticket-integrations
T="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
command -v "$T" >/dev/null 2>&1 || T=tauri-agent-tools

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${TAURI_SURFACE_VERIFY_TICKET_INTEGRATIONS_OUT:-/tmp/pcv-ticket-integrations-$STAMP}"
mkdir -p "$OUT_DIR"
TICKET_VERIFY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$TICKET_VERIFY_ROOT/libs/generic/verification-harness/bin/vh.sh"
vh_phase preflight ""
vh_phase native-assertions preflight
vh_init ticket-integrations "$OUT_DIR/harness"
vh_bracket_trap
vh_begin preflight

capture_screenshot() {
  local target="$1" status window_id
  # tauri-agent-tools 0.9.3 accepts --pid as a bridge selector, but screenshot
  # still requires a selector/title/window-id and its title fallback can target
  # another process. Resolve the visible Tauri window from the verifier PID,
  # then pass that exact OS window id to screenshot.
  window_id="$(
    "$T" list-windows --json |
      node - "$VERIFY_TAURI_PID" 3<&0 <<'NODE'
const fs = require('node:fs');

const [pidText] = process.argv.slice(2);
const pid = Number(pidText);
let windows;
try {
  windows = JSON.parse(fs.readFileSync(3, 'utf8'));
} catch (error) {
  console.error(`window-inventory-json:${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (!Array.isArray(windows) || !Number.isInteger(pid)) {
  console.error('window-inventory-shape');
  process.exit(1);
}
const candidates = windows
  .filter((window) => Number(window?.pid) === pid && window?.tauri === true)
  .filter((window) => Number.isFinite(window?.width) && Number.isFinite(window?.height))
  .filter((window) => window.width > 0 && window.height > 0)
  .sort((a, b) => (b.width * b.height) - (a.width * a.height));
if (candidates.length === 0 || !/^[0-9]+$/.test(String(candidates[0].windowId))) {
  console.error(`no-owned-tauri-window:pid=${pidText}`);
  process.exit(1);
}
process.stdout.write(String(candidates[0].windowId));
NODE
  )" || {
    echo "Could not resolve a visible Tauri window for verifier PID $VERIFY_TAURI_PID" >&2
    return 1
  }
  "$T" screenshot --window-id "$window_id" --output "$target" >"$target.stdout.log" 2>"$target.stderr.log"
  status=$?
  if [ "$status" -ne 0 ]; then
    cat "$target.stderr.log" >&2
    cat "$target.stdout.log" >&2
    return "$status"
  fi
  [ -s "$target" ] || { echo "Screenshot command produced no image: $target" >&2; return 1; }
}
fail() {
  echo "VERIFY_FAIL: $*"
  capture_screenshot "$OUT_DIR/failure.png" || true
  echo "P007_TAURI_SURFACE_VERIFY_FAIL leg=$LEG output=$OUT_DIR"
  exit 1
}
# eval stdout is a value protocol; CLI diagnostics must remain on stderr.
ev() { "$T" eval --pid "$VERIFY_TAURI_PID" "$1"; }
unq() { sed -e 's/^"//' -e 's/"$//'; }
body() { ev "(document.querySelector('main') || document.body).innerText.slice(0, 900) + ' | url=' + location.pathname + location.search"; }
waitjs() {
  "$T" wait --pid "$VERIFY_TAURI_PID" --eval "$1" --timeout "${2:-30000}" --interval 500 >/dev/null 2>&1 \
    || fail "timed out waiting for: $1 :: page text: $(body)"
}
nav() {
  ev "window.history.pushState({}, '', '$1'); window.dispatchEvent(new PopStateEvent('popstate')); 'ok'" >/dev/null
}
step() { echo "VERIFY_STEP: $*"; }

[ "${VERIFY_TAURI_ISOLATED_DB:-0}" = "1" ] || fail "set VERIFY_TAURI_ISOLATED_DB=1: this leg writes a data source"
[ "${PAPERCUSP_VERIFY_TAURI_ISOLATED:-0}" = "1" ] || fail "rig is not isolated; refusing to seed a data source"
[ -n "${HARNESS_ADMIN_DATABASE_URL:-}" ] || fail "no isolated HARNESS_ADMIN_DATABASE_URL"
psql_iso() { psql "$HARNESS_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "$1"; }

# 1. The page renders from the live provider registry, reached from the settings nav, and every
#    registered ticket provider is offered as connectable.
vh_begin native-assertions
nav /settings/integrations
waitjs "!!document.querySelector('h1') && document.querySelector('h1').textContent === 'Integrations' && !document.body.innerText.includes('Loading integrations')" 90000
step "page rendered at $(ev 'location.pathname')"
[ "$(ev "String(!!document.querySelector('a[href=\"/settings/integrations\"]'))" | unq)" = "true" ] || fail "no settings nav link to /settings/integrations"
step "settings nav links to the page"
ALERT="$(ev "(document.querySelector('[role=alert]') || {}).textContent || ''" | unq)"
[ -z "$ALERT" ] || fail "page shows an alert: $ALERT"
PROVIDERS="$(ev "JSON.stringify([...document.querySelectorAll('[data-provider]')].map((e) => e.getAttribute('data-provider')))")"
step "providers rendered: $(tr -d ' \n' <<<"$PROVIDERS")"
grep -q '"linear"' <<<"$PROVIDERS" || fail "Linear is not listed while registered: $PROVIDERS :: $(body)"
grep -q '"asana"' <<<"$PROVIDERS" || fail "Asana is not listed while registered: $PROVIDERS"
for NAME in Linear Asana; do
  [ "$(ev "String([...document.querySelectorAll('button')].some((b) => b.textContent === 'Connect $NAME'))" | unq)" = "true" ] \
    || fail "no 'Connect $NAME' button :: $(body)"
done
step "Connect Linear and Connect Asana offered"
capture_screenshot "$OUT_DIR/integrations.png" || fail "screenshot failed"

# Negative control: the same check against a provider that is not registered must fail, so a
# passing check above is a real observation, not an instrument that always says yes.
[ "$(ev "String(!!document.querySelector('[data-provider=\"not-a-registered-provider\"]'))" | unq)" = "false" ] \
  || fail "negative control: an unregistered provider card was reported present"
step "negative control: an unregistered provider is not reported"

# 2. The user the routes act for (the same read the page made).
ev "window.__vti = null; fetch('/api/user/integrations/tickets', { cache: 'no-store' }).then((r) => r.json()).then((j) => { window.__vti = j; }); 'started'" >/dev/null
waitjs "window.__vti !== null"
USER_ID="$(ev "window.__vti.userId" | unq)"
[[ "$USER_ID" =~ ^[0-9a-f-]{36}$ ]] || fail "GET returned no userId: $(ev 'JSON.stringify(window.__vti)')"
WS="${PAPERCUSP_WORKSPACE_ID:-}"
[ -n "$WS" ] || fail "no PAPERCUSP_WORKSPACE_ID from the rig"
step "user=$USER_ID workspace=$WS"

# 3. A source written to the database appears on the open page with no reload (change-notify
#    trigger from migration 1399 -> integrations.tickets invalidation -> live query).
SOURCE_ID="$(psql_iso "INSERT INTO harness_shared.data_sources (workspace_id, kind, sync_mode, scope, owner_user_id, provider_account_id, status, config)
  VALUES ('$WS', 'linear', 'poll', 'personal', '$USER_ID'::uuid, 'verify-org', 'connected', '{\"accountLabel\":\"Verify Org\"}'::jsonb) RETURNING id")" \
  || fail "seed insert failed"
SOURCE_ID="$(head -1 <<<"$SOURCE_ID")"
step "seeded source $SOURCE_ID"
if ! "$T" wait --pid "$VERIFY_TAURI_PID" --eval "!!document.querySelector('[data-source=\"$SOURCE_ID\"]')" --timeout 30000 --interval 500 >/dev/null 2>&1; then
  fail "seeded source did not appear on the open page: the live update did not arrive :: $(body)"
fi
step "seeded source appeared live, without reload"
ROW="$(ev "document.querySelector('[data-source=\"$SOURCE_ID\"]').innerText")"
grep -q 'Verify Org' <<<"$ROW" || fail "row lacks its account label: $ROW"
grep -q 'Needs teams and a harness to store tickets in before it can sync.' <<<"$ROW" || fail "row does not say what it needs: $ROW"
step "row says: needs teams and a harness"

# 4. Opening What syncs calls the real containers route; with no credential it fails cleanly and
#    the panel falls back to id fields. The open source and panel are URL state.
"$T" click --pid "$VERIFY_TAURI_PID" "[data-source=\"$SOURCE_ID\"] button[aria-controls]" >/dev/null 2>&1 || fail "could not click What syncs"
# nuqs omits a param equal to its default, and the panel defaults to 'scope': only source= appears.
waitjs "location.search.includes('source=$SOURCE_ID') && !/[?&]panel=(?!scope)/.test(location.search)"
step "URL state: $(ev 'location.search')"
waitjs "!!document.querySelector('[aria-label=\"What syncs\"]') && !document.body.innerText.includes('Asking Linear')" 45000
PANEL="$(ev "document.querySelector('[aria-label=\"What syncs\"]').innerText")"
step "panel: $(tr '\n' ' ' <<<"$PANEL" | cut -c1-300)"
grep -q 'Teams' <<<"$PANEL" || fail "panel offers no Teams id field: $PANEL"

# 5. A config write through the real route clears the missing-config line live.
ev "window.__vtp = null; fetch('/api/user/integrations/tickets/sources/$SOURCE_ID/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { teamIds: ['team-verify'], harnessSlug: 'papercusp' } }) }).then((r) => r.json()).then((j) => { window.__vtp = j; }); 'started'" >/dev/null
waitjs "window.__vtp !== null"
PATCHED="$(ev 'JSON.stringify(window.__vtp)')"
# Structural, not textual: eval output is pretty-printed, so a compact-JSON grep never matches.
[ "$(ev "String(window.__vtp.ok === true && Array.isArray(window.__vtp.missingConfig) && window.__vtp.missingConfig.length === 0)" | unq)" = "true" ] \
  || fail "PATCH did not report a complete config: $PATCHED"
step "PATCH ok, missingConfig []"
waitjs "!document.querySelector('[data-source=\"$SOURCE_ID\"]').innerText.includes('before it can sync')"
step "missing-config line cleared live"
CONFIG="$(psql_iso "SELECT config::text FROM harness_shared.data_sources WHERE id = '$SOURCE_ID'")"
grep -q 'team-verify' <<<"$CONFIG" || fail "config not persisted: $CONFIG"
step "persisted config: $CONFIG"

# 6. /admin/admission shows the same source from the same read, linked back to its settings.
nav /admin/admission
waitjs "!!document.querySelector('section[aria-label=\"Ticket sources\"] table')" 60000
ADMIN="$(ev "document.querySelector('section[aria-label=\"Ticket sources\"]').innerText")"
grep -q 'Verify Org' <<<"$ADMIN" || fail "admin table lacks the source: $ADMIN"
HREF="$(ev "document.querySelector('section[aria-label=\"Ticket sources\"] a[href*=\"source=\"]').getAttribute('href')" | unq)"
[ "$HREF" = "/settings/integrations?source=$SOURCE_ID&panel=scope" ] || fail "Configure link is $HREF"
step "admin Ticket sources row + Configure link ok"
capture_screenshot "$OUT_DIR/admin-ticket-sources.png" || fail "screenshot failed"

echo "VERIFY_OK: integrations page, live updates, containers fallback, config write, admin table"
echo "P007_TAURI_SURFACE_VERIFY_OK leg=$LEG output=$OUT_DIR"

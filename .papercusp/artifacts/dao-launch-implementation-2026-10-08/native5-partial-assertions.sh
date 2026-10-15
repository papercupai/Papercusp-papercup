#!/usr/bin/env bash
# DAO launch regression leg in the maintained native surface suite.
# Run through verify-tauri-headless with an isolated DB, ready seed and fresh DAO SPA.
set -euo pipefail
SYNTAX_ONLY=0
if [ "${1:-}" = --check-syntax ]; then
  SYNTAX_ONLY=1
  VERIFY_TAURI_PID=syntax-only
  VERIFY_TAURI_POLL=dao_syntax_poll
  VERIFY_TAURI_LIVENESS_CHECK=:
  VERIFY_TAURI_ISOLATED_DB=1
fi
check_js() { node -e 'new (require("node:vm").Script)(process.argv[1])' "$1"; }
dao_syntax_poll() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --eval ]; then check_js "$2"; shift 2; else shift; fi
  done
}
: "${VERIFY_TAURI_PID:?run through verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing native DOM poll helper}"
: "${VERIFY_TAURI_LIVENESS_CHECK:?missing owned-process liveness helper}"
[ "${VERIFY_TAURI_ISOLATED_DB:-0}" = 1 ] || { echo 'DAO verification requires an isolated DB' >&2; exit 2; }
if [ "$SYNTAX_ONLY" = 1 ]; then
  OUT_DIR="$(mktemp -d)"
else
  OUT_DIR="${TAURI_SURFACE_VERIFY_DAO_LAUNCH_OUT:-/tmp/pcv-dao-launch-$(date -u +%Y%m%dT%H%M%SZ)}"
fi
mkdir -p "$OUT_DIR"
cp "$0" "$OUT_DIR/assertions.sh"
if [ -n "${VERIFY_TAURI_SPA_DIST:-}" ] && [ -f "$VERIFY_TAURI_SPA_DIST/../verifier-source-receipt.json" ]; then
  cp "$VERIFY_TAURI_SPA_DIST/../verifier-source-receipt.json" "$OUT_DIR/backend-source-receipt.json"
fi
trap 'status=$?; if [ "$SYNTAX_ONLY" = 1 ]; then rm -rf -- "$OUT_DIR"; elif [ "$status" -ne 0 ]; then echo "P009_TAURI_SURFACE_VERIFY_FAIL leg=dao-launch output=$OUT_DIR" >&2; fi' EXIT
if [ "$SYNTAX_ONLY" != 1 ]; then
  # The verifier executes a frozen copy under WORK, outside the scripts tree.
  DAO_VERIFY_ROOT="${VERIFY_TAURI_ORIGINAL_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  source "$DAO_VERIFY_ROOT/libs/generic/verification-harness/bin/vh.sh"
  vh_phase native-assertions ""
  vh_init dao-launch "$OUT_DIR/harness"
  vh_bracket_trap
  vh_begin native-assertions
fi
native() {
  if [ "$1" = eval ]; then check_js "$2"; fi
  if [ "$SYNTAX_ONLY" = 1 ]; then
    [ "$1" != check ] # The missing-selector control is a runtime check only.
    return
  fi
  bash "$VERIFY_TAURI_LIVENESS_CHECK" >/dev/null
  tauri-agent-tools "$@" --pid "$VERIFY_TAURI_PID"
}
native eval 'window.__TSR_ROUTER__.navigate({to:"/dao"})' >/dev/null
"$VERIFY_TAURI_POLL" --selector '[data-testid="dao-launch-workspace"]'
# Native prototype setters preserve React input tracking. The CLI type command
# currently assigns el.value directly (EI-25430344575489294).
define_type_helper() {
  native eval 'window.__daoSurfaceType=(label,value)=>{const e=[...document.querySelectorAll(".dao-form input,.dao-form textarea")].find(x=>x.getAttribute("aria-label")===label);if(!e)throw Error("Missing field "+label);e.focus();const setter=Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set;setter.call(e,"");e.dispatchEvent(new Event("input",{bubbles:true}));setter.call(e,value);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));e.blur();};' >/dev/null
}
define_type_helper
native click '.dao-sidebar-create' >/dev/null
"$VERIFY_TAURI_POLL" --selector 'input[aria-label="Organization name"]'
native eval '__daoSurfaceType("Organization name","Native DAO regression");__daoSurfaceType("Shared purpose","Prepare a shared organization with transparent governance.")' >/dev/null
native click '.dao-form .dao-button.primary' >/dev/null
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval 'document.querySelectorAll(".dao-task").length===5 && document.querySelector(".dao-summary-value").textContent.includes("1 of 5 steps prepared")'
native click '.dao-task.next .dao-button.primary' >/dev/null
"$VERIFY_TAURI_POLL" --selector 'input[aria-label="Quorum (%)"]'
native eval '__daoSurfaceType("Quorum (%)","75");__daoSurfaceType("Responsible person","Native reviewer")' >/dev/null
native click '.dao-form-footer .dao-button.primary' >/dev/null
"$VERIFY_TAURI_POLL" --selector '.dao-notice' --text 'Draft saved.'
native eval 'location.reload()' >/dev/null
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval 'document.querySelector(".dao-org-select").textContent.includes("Native DAO regression") && document.querySelectorAll(".dao-task")[1].textContent.includes("Native reviewer")'
native click '.dao-task.next .dao-button.primary' >/dev/null
"$VERIFY_TAURI_POLL" --require 'input[aria-label="Quorum (%)"]' --eval 'document.querySelector("input[aria-label=\"Quorum (%)\"]").value==="75"'
native eval 'document.querySelector("[role=dialog] button[aria-label=Close]").click()' >/dev/null
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval '!document.querySelector(".dao-modal")'
# A wide desktop can leave a narrow content pane when chat is open. Check the
# page at that actual containing width, and at a still narrower host width.
define_layout_guard() {
  native eval 'window.__daoLayoutFits=()=>{const host=document.querySelector(".dao-workspace-container");if(!host)return false;const h=host.getBoundingClientRect();return [".dao-sidebar",".dao-summary",".dao-checklist",".dao-next-column"].every(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return r && r.width>100 && r.left>=h.left-2 && r.right<=h.right+2 && e.scrollWidth<=e.clientWidth+2;});}' >/dev/null
}
define_layout_guard
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval '__daoLayoutFits()'
native eval 'document.querySelector(".dao-workspace-container").style.width="560px"' >/dev/null
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval '__daoLayoutFits()'
native eval 'document.querySelector(".dao-workspace-container").style.width=""' >/dev/null
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval '__daoLayoutFits() && document.querySelector(".dao-summary").textContent.includes("Not connected")'
native eval 'JSON.stringify({viewport:{width:innerWidth,height:innerHeight},containerWidth:document.querySelector(".dao-workspace-container").getBoundingClientRect().width,checklistWidth:document.querySelector(".dao-checklist").getBoundingClientRect().width,steps:document.querySelectorAll(".dao-task").length,organization:document.querySelector(".dao-org-select").textContent})' >"$OUT_DIR/layout.json"
native screenshot --selector '[data-testid="dao-launch-workspace"]' --output "$OUT_DIR/checklist.png" >/dev/null
# Exercise the real app theme picker; setting CSS tokens directly would not
# prove that the saved app preference and DAO surface stay in sync.
for theme in portal-light portal-dark; do
  native click 'button[aria-label="Switch theme"]' >/dev/null
  "$VERIFY_TAURI_POLL" --selector "[data-testid=\"theme-selector-option\"][data-theme-id=\"$theme\"]"
  native click "[data-testid=\"theme-selector-option\"][data-theme-id=\"$theme\"]" >/dev/null
  "$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval "document.documentElement.dataset.theme===\"$theme\" && __daoLayoutFits()"
  native eval 'JSON.stringify({theme:document.documentElement.dataset.theme,background:getComputedStyle(document.querySelector(".dao-workspace")).backgroundColor,foreground:getComputedStyle(document.querySelector(".dao-workspace")).color,steps:document.querySelectorAll(".dao-task").length,url:location.href})' >"$OUT_DIR/theme-$theme.json"
  native screenshot --selector '[data-testid="dao-launch-workspace"]' --output "$OUT_DIR/theme-$theme.png" >/dev/null
  native eval 'location.reload()' >/dev/null
  "$VERIFY_TAURI_POLL" --selector '[data-testid="dao-launch-workspace"]'
  define_layout_guard
  "$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval "document.documentElement.dataset.theme===\"$theme\" && document.querySelector(\".dao-org-select\").textContent.includes(\"Native DAO regression\") && __daoLayoutFits()"
done
# Keep legal routing evidence separate from source receipts. Both branches
# must render the saved jurisdiction after reload and reopen with that value.
native eval 'document.querySelectorAll(".dao-sidebar nav button")[4].click()' >/dev/null
"$VERIFY_TAURI_POLL" --selector '.dao-section-overview' --text 'legal entity'
for route in new existing; do
  if [ "$route" = new ]; then
    legal_country=CA; legal_option='Prepare a new entity with an advisor'; legal_title='Prepare a new'
  else
    legal_country=US; legal_option='Use an existing legal entity'; legal_title='Connect an existing'
  fi
  native click '.dao-section-overview .dao-button.primary' >/dev/null
  "$VERIFY_TAURI_POLL" --selector 'input[aria-label="Country / jurisdiction"]'
  native click '[role="combobox"][aria-label="Legal route"]' >/dev/null
  "$VERIFY_TAURI_POLL" --selector '[role="option"]'
  native eval "const option=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('$legal_option'));if(!option)throw Error('Missing legal route option');option.setAttribute('data-native-dao-route','selected');" >/dev/null
  native click '[data-native-dao-route="selected"]' >/dev/null
  define_type_helper
  native eval "__daoSurfaceType('Country / jurisdiction','$legal_country');__daoSurfaceType('Legal entity name','Native $route entity');" >/dev/null
  native click '.dao-form-footer .dao-button.primary' >/dev/null
  "$VERIFY_TAURI_POLL" --selector '.dao-notice' --text 'Draft saved.'
  native eval 'location.reload()' >/dev/null
  "$VERIFY_TAURI_POLL" --selector '.dao-section-overview' --text "Native $route entity"
  "$VERIFY_TAURI_POLL" --selector '.dao-section-overview' --eval "document.querySelector('.dao-section-overview').textContent.includes('$legal_country') && document.querySelector('.dao-section-overview h2').textContent.includes('$legal_title')"
  native screenshot --selector '[data-testid="dao-launch-workspace"]' --output "$OUT_DIR/legal-$route-panel.png" >/dev/null
  native click '.dao-section-overview .dao-button.primary' >/dev/null
  "$VERIFY_TAURI_POLL" --selector 'input[aria-label="Country / jurisdiction"]' --eval "document.querySelector('input[aria-label=\"Country / jurisdiction\"]').value==='$legal_country' && document.querySelector('[role=combobox][aria-label=\"Legal route\"]').textContent.includes('$legal_option')"
  native eval 'JSON.stringify({url:location.href,country:document.querySelector("input[aria-label=\"Country / jurisdiction\"]").value,route:document.querySelector("[role=combobox][aria-label=\"Legal route\"]").textContent,entity:document.querySelector("input[aria-label=\"Legal entity name\"]").value,panel:document.querySelector(".dao-section-overview").textContent})' >"$OUT_DIR/legal-$route.json"
  native eval 'document.querySelector("[role=dialog] button[aria-label=Close]").click()' >/dev/null
  "$VERIFY_TAURI_POLL" --selector '.dao-section-overview' --eval '!document.querySelector(".dao-modal")'
done
if native check --selector '.dao-task-intentionally-missing' --json >"$OUT_DIR/negative-control.json" 2>&1; then
  echo 'Missing-selector negative control unexpectedly passed' >&2; exit 1
fi
if [ "$SYNTAX_ONLY" = 1 ]; then
  echo 'DAO_SURFACE_SYNTAX_ONLY parsed all branches; no native verification performed'
else
  echo "P009_TAURI_SURFACE_VERIFY_OK leg=dao-launch output=$OUT_DIR"
fi

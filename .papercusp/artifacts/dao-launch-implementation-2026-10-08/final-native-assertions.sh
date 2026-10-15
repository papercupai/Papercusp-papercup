#!/usr/bin/env bash
# DAO launch regression leg in the maintained native surface suite.
# Run through verify-tauri-headless with an isolated DB, ready seed and fresh DAO SPA.
set -euo pipefail
: "${VERIFY_TAURI_PID:?run through verify-tauri-headless.sh}"
: "${VERIFY_TAURI_POLL:?missing native DOM poll helper}"
: "${VERIFY_TAURI_LIVENESS_CHECK:?missing owned-process liveness helper}"
[ "${VERIFY_TAURI_ISOLATED_DB:-0}" = 1 ] || { echo 'DAO verification requires an isolated DB' >&2; exit 2; }
OUT_DIR="${TAURI_SURFACE_VERIFY_DAO_LAUNCH_OUT:-/tmp/pcv-dao-launch-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR"
cp "$0" "$OUT_DIR/assertions.sh"
if [ -n "${VERIFY_TAURI_SPA_DIST:-}" ] && [ -f "$VERIFY_TAURI_SPA_DIST/../verifier-source-receipt.json" ]; then
  cp "$VERIFY_TAURI_SPA_DIST/../verifier-source-receipt.json" "$OUT_DIR/backend-source-receipt.json"
fi
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "P009_TAURI_SURFACE_VERIFY_FAIL leg=dao-launch output=$OUT_DIR" >&2; fi' EXIT
native() { bash "$VERIFY_TAURI_LIVENESS_CHECK" >/dev/null; tauri-agent-tools "$@" --pid "$VERIFY_TAURI_PID"; }
native eval 'window.__TSR_ROUTER__.navigate({to:"/dao"})' >/dev/null
"$VERIFY_TAURI_POLL" --selector '[data-testid="dao-launch-workspace"]'
# Native prototype setters preserve React input tracking. The CLI type command
# currently assigns el.value directly (EI-25430344575489294).
native eval 'window.__daoSurfaceType=(label,value)=>{const e=[...document.querySelectorAll(".dao-form input,.dao-form textarea")].find(x=>x.getAttribute("aria-label")===label);if(!e)throw Error("Missing field "+label);e.focus();const setter=Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set;setter.call(e,"");e.dispatchEvent(new Event("input",{bubbles:true}));setter.call(e,value);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));e.blur();};' >/dev/null
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
native eval 'window.__daoLayoutFits=()=>{const host=document.querySelector(".dao-workspace-container");if(!host)return false;const h=host.getBoundingClientRect();return [".dao-sidebar",".dao-summary",".dao-checklist",".dao-next-column"].every(s=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return r && r.width>100 && r.left>=h.left-2 && r.right<=h.right+2 && e.scrollWidth<=e.clientWidth+2;});}' >/dev/null
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval '__daoLayoutFits()'
native eval 'document.querySelector(".dao-workspace-container").style.width="560px"' >/dev/null
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval '__daoLayoutFits()'
native eval 'document.querySelector(".dao-workspace-container").style.width=""' >/dev/null
"$VERIFY_TAURI_POLL" --require '.dao-task' --require-min 5 --eval '__daoLayoutFits() && document.querySelector(".dao-summary").textContent.includes("Not connected")'
native eval 'JSON.stringify({viewport:{width:innerWidth,height:innerHeight},containerWidth:document.querySelector(".dao-workspace-container").getBoundingClientRect().width,checklistWidth:document.querySelector(".dao-checklist").getBoundingClientRect().width,steps:document.querySelectorAll(".dao-task").length,organization:document.querySelector(".dao-org-select").textContent})' >"$OUT_DIR/layout.json"
native screenshot --selector '[data-testid="dao-launch-workspace"]' --output "$OUT_DIR/checklist.png" >/dev/null
if native check --selector '.dao-task-intentionally-missing' --json >"$OUT_DIR/negative-control.json" 2>&1; then
  echo 'Missing-selector negative control unexpectedly passed' >&2; exit 1
fi
echo "P009_TAURI_SURFACE_VERIFY_OK leg=dao-launch output=$OUT_DIR"

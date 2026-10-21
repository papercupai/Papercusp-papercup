#!/usr/bin/env bash
# Tenant density on ONE GCP capacity VM: how many Papercusp Server tenants fit, and what each one costs
# (plan agent-capacity-and-cost-gcp-2026-09-30, P-011 / D-036 / D-045). Moved from
# .papercusp/scratch/p011/run.sh by WI-10006497. That run's one-off Phase A (idle unload on vs off,
# WI-10005070, concluded net-negative) is expressible here as TENANT_ENV_pct2=PAPERCUSP_EMBED_WORKER_IDLE_MS=0.
#
# Installs a TEST-ARTIFACT .deb (build-test-deb.sh) as tenants pct1, pct2, ... (one Linux user each,
# install-server.sh SVC_USER), every one seeded with the doc-vector seed so no first-boot backfill skews the
# footprint. Tenants are added in STEPS: for each K, tenants are added up to K, then the run holds STEP_MIN
# minutes with a CENSUS every CENSUS_SEC (host MemAvailable/load + each tenant's cgroup memory.current).
# sample-footprint.py records every tenant's cgroup every 30 s for footprint-summary.ts.
# It stops adding tenants once host MemAvailable falls below MIN_AVAIL_GIB after a step (STOP_LOW_MEM).
# Teardown is armed BEFORE the VM is created (a half-created VM bills). Run it under `systemd-run --user`
# so an operator restart cannot kill it mid-run (the scratch driver needed a RESUME mode for that).
#
#   DEB_LOCAL=<test-artifact .deb> RUN=density1 bash scripts/agent-capacity/vm/tenant-density.sh \
#     > ~/.cache/agent-capacity/density1/run.log 2>&1
#
# Env: DEB_LOCAL (required) · RUN (density) · VM (cap-$RUN) · MACHINE (e2-standard-16) · STEPS ("4 8 12 16",
# the tenant count after each step) · STEP_MIN (30) · CENSUS_SEC (900) · MIN_AVAIL_GIB (6) · TENANT_ENV (extra
# KEY=VAL for every tenant) · TENANT_ENV_<tenant> (extra for one tenant) · MAX_HOURS (8, the gcp-rails
# self-delete) · SEED_TGZ (~/.cache/agent-capacity/p011/seed.tgz) · AGENT_CAPACITY_OUT
# (~/.cache/agent-capacity/$RUN) · SSH_RETRY_SLEEP (10).
# Exit: 0 observed · 2 missing input · 3 upload/create failed · 4 staging failed.
set -uo pipefail
VMDIR=$(cd "$(dirname "$0")" && pwd) || exit 2
ROOT=$(cd "$VMDIR/../../.." && pwd) || exit 2
cd "$ROOT" || exit 2
P=pc-agent-capacity-0930; Z=us-central1-a
RUN=${RUN:-density}; VM=${VM:-cap-$RUN}
MACHINE=${MACHINE:-e2-standard-16}; MAX_HOURS=${MAX_HOURS:-8}
STEPS=${STEPS:-"4 8 12 16"}; STEP_MIN=${STEP_MIN:-30}; CENSUS_SEC=${CENSUS_SEC:-900}; MIN_AVAIL_GIB=${MIN_AVAIL_GIB:-6}
TENANT_ENV=${TENANT_ENV:-}
OUT=${AGENT_CAPACITY_OUT:-$HOME/.cache/agent-capacity/$RUN}
SEED_TGZ=${SEED_TGZ:-$HOME/.cache/agent-capacity/p011/seed.tgz}
DEB_LOCAL=${DEB_LOCAL:-}
ts() { date -u +%FT%TZ; }
[ -n "$DEB_LOCAL" ] || { echo "USAGE: DEB_LOCAL=<test-artifact .deb> [RUN=...] [STEPS='4 8'] $0"; exit 2; }
[ -f "$DEB_LOCAL" ] || { echo "NO_DEB $DEB_LOCAL"; exit 2; }
[ -f "$SEED_TGZ" ] || { echo "NO_SEED $SEED_TGZ"; exit 2; }
prev=0
for K in $STEPS; do
  case "$K" in '' | *[!0-9]*) echo "USAGE: STEPS must be increasing tenant counts, got '$STEPS'"; exit 2 ;; esac
  [ "$K" -gt "$prev" ] || { echo "USAGE: STEPS must be increasing tenant counts, got '$STEPS'"; exit 2; }
  prev=$K
done
mkdir -p "$OUT" || exit 2
ssh_vm() { timeout "${2:-900}" gcloud compute ssh "$VM" --zone="$Z" --project="$P" --command="$1"; }

SHA=$(sha256sum "$DEB_LOCAL" | cut -d' ' -f1)
DEB=gs://pc-agent-capacity-0930-artifacts/$RUN/$(basename "$DEB_LOCAL" | tr ' ' '_')
echo "RUN_CONFIG vm=$VM machine=$MACHINE steps='$STEPS' step=${STEP_MIN}m census=${CENSUS_SEC}s minAvail=${MIN_AVAIL_GIB}GiB tenantEnv='$TENANT_ENV' deb=$DEB sha=$SHA out=$OUT $(ts)"
gcloud storage ls "$DEB" >/dev/null 2>&1 || gcloud storage cp "$DEB_LOCAL" "$DEB" --no-user-output-enabled || { echo "UPLOAD_FAILED"; exit 3; }

teardown() {
  trap - EXIT
  echo "TEARDOWN_START $(ts)"
  npx tsx scripts/agent-capacity/gcp-rails.ts teardown --run="$RUN"
  echo "DENSITY_DONE rc=$? $(ts)"
}
trap teardown EXIT
trap 'exit 143' TERM INT
echo "CREATE_START $(ts)"
npx tsx scripts/agent-capacity/gcp-rails.ts create --run="$RUN" --name="$VM" --machine-type="$MACHINE" --max-hours="$MAX_HOURS" \
  || { echo "CREATE_FAILED"; exit 3; }
ssh_ready=0
ssh_tries=0
for try in $(seq 1 30); do
  ssh_tries=$try
  if ssh_vm true 60 >/dev/null 2>&1; then echo "SSH_READY try=$try $(ts)"; ssh_ready=1; break; fi
  sleep "${SSH_RETRY_SLEEP:-10}"
done
[ "$ssh_ready" -eq 1 ] || { echo "SSH_NOT_READY tries=$ssh_tries $(ts)"; exit 4; }
gcloud compute scp "$VMDIR/install-server.sh" "$VMDIR/sample-footprint.py" "$VMDIR/host-sampler.sh" "$SEED_TGZ" \
  "$VM:/tmp/" --zone="$Z" --project="$P" || { echo "SCP_FAILED"; exit 4; }
ssh_vm "set -e; sudo mkdir -p /opt/agent-capacity/seed; sudo tar xzf /tmp/$(basename "$SEED_TGZ") -C /opt/agent-capacity/seed;
  sudo chmod -R a+rX /opt/agent-capacity; du -sh /opt/agent-capacity/seed" || { echo "SEED_STAGE_FAILED"; exit 4; }
ssh_vm 'nohup bash /tmp/host-sampler.sh > /tmp/host.log 2>&1 & sleep 2; tail -n 1 /tmp/host.log' 60

BASE_ENV="PAPERCUSP_DISABLE_DOGFOOD_HIVE=1 PAPERCUSP_DOC_VECTOR_SEED_DIR=/opt/agent-capacity/seed"
TENANTS=""
start_tenant() { # $1 = tenant user
  local u=$1 tenv_var tenv rc cg port
  tenv_var="TENANT_ENV_$u"; tenv="$TENANT_ENV ${!tenv_var:-}"; tenv=$(echo "$tenv" | xargs)
  echo "TENANT_START $u env='$tenv' $(ts)"
  # shellcheck disable=SC2086
  ssh_vm "SVC_USER=$u bash /tmp/install-server.sh $DEB $SHA $BASE_ENV $tenv" > "$OUT/install-$u.out" 2>&1
  rc=$?
  cg=$(sed -n 's/^SERVER_CGROUP=//p' "$OUT/install-$u.out"); port=$(sed -n 's/^SERVER_PORT=//p' "$OUT/install-$u.out")
  echo "TENANT_RESULT $u rc=$rc port=${port:-none} cg=${cg:-none} $(grep -E '^(T_BOOT_TO_HEALTH|SERVER_ENV_NOT_APPLIED)=' "$OUT/install-$u.out" | tr '\n' ' ') $(ts)"
  # A failed tenant is recorded, not fatal: the density at which installs start failing is itself a result.
  [ $rc -eq 0 ] || tail -n 15 "$OUT/install-$u.out" | sed "s/^/  [$u] /"
  TENANTS="$TENANTS $u"
  [ -n "$cg" ] && ssh_vm "echo '$cg' > /tmp/cg-$u; nohup python3 /tmp/sample-footprint.py --cgroup '$cg' --interval 30 --duration 30000 --out /tmp/fp-$u.jsonl --label $u >/tmp/sampler-$u.log 2>&1 &" 60
  return 0
}
# The host line plus each tenant's cgroup memory.current (bytes): the density evidence at one instant.
census() {
  echo "#### CENSUS $1 tenants=$(echo $TENANTS | wc -w) $(ts)"
  ssh_vm "tail -n 1 /tmp/host.log; for u in $TENANTS; do cg=\$(cat /tmp/cg-\$u 2>/dev/null); echo \"TENANT_MEM \$u cur=\$(cat \$cg/memory.current 2>/dev/null || echo na)\"; done" 120
}
pull() {
  ssh_vm "cd /tmp && tar czf /tmp/$RUN-ev.tgz host.log fp-*.jsonl sampler-*.log 2>/dev/null; echo PACKED" 300 >/dev/null 2>&1
  gcloud compute scp "$VM:/tmp/$RUN-ev.tgz" "$OUT/ev.tgz.part" --zone="$Z" --project="$P" >/dev/null 2>&1 \
    && mv "$OUT/ev.tgz.part" "$OUT/ev.tgz" && echo "EV_PULLED $(ts)" || echo "EV_PULL_FAILED $(ts)"
}

have=0
for K in $STEPS; do
  echo "STEP_START K=$K $(ts)"
  while [ "$have" -lt "$K" ]; do have=$((have + 1)); start_tenant "pct$have"; done
  census "K${K}-0"
  n=$(( STEP_MIN * 60 / (CENSUS_SEC > 0 ? CENSUS_SEC : 1) ))
  for m in $(seq 1 "$n"); do sleep "$CENSUS_SEC"; census "K${K}-$((m * CENSUS_SEC / 60))m"; done
  pull
  avail=$(ssh_vm "awk '/^MemAvailable:/{print int(\$2/1048576)}' /proc/meminfo" 60 | tail -n 1)
  echo "STEP_END K=$K memAvailableGiB=${avail:-unknown} $(ts)"
  case "${avail:-}" in '' | *[!0-9]*) ;; *) [ "$avail" -lt "$MIN_AVAIL_GIB" ] && { echo "STOP_LOW_MEM avail=${avail}GiB at K=$K"; break; } ;; esac
done
pull
exit 0

#!/usr/bin/env bash
# P-012 / owner #1062 (plan agent-capacity-and-cost-gcp-2026-09-30): measure what resizing a GCE VM
# costs a running workspace. Can the machine type change while the VM runs, and if not, how long is
# the outage (stop + set-machine-type + start + guest reachable over SSH)?
#
# One tiny on-demand VM through gcp-rails (labels + max-cost + max-run-duration). Before restarting,
# pin the original lifetime to an absolute DELETE deadline: max-run-duration resets on each start.
# The teardown runs
# on every exit path, including a failed create. Moved from .papercusp/scratch/gce-resize/run.sh
# (WI-10006497); measured result is in D-046/SIZE-GUIDE.md.
#
# Every knob is an env var so the test (gce-resize.test.ts) can drive it against a fake gcloud/npx:
#   GCP_PROJECT, GCP_ZONE, RESIZE_FROM, RESIZE_TO, RESIZE_RUN, AGENT_CAPACITY_OUT,
#   RESIZE_SSH_TRIES (default 60), RESIZE_SSH_SLEEP (default 3), AGENT_CAPACITY_ROOT.
set -u
ROOT=${AGENT_CAPACITY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}
cd "$ROOT" || exit 1
P=${GCP_PROJECT:-pc-agent-capacity-0930}
Z=${GCP_ZONE:-us-central1-a}
FROM=${RESIZE_FROM:-e2-standard-2}
TO=${RESIZE_TO:-e2-standard-4}
RUN=${RESIZE_RUN:-resize$(date -u +%m%d%H%M)}
VM=cap-$RUN
OUT=${AGENT_CAPACITY_OUT:-$HOME/.cache/agent-capacity/gce-resize}
SSH_TRIES=${RESIZE_SSH_TRIES:-60}
SSH_SLEEP=${RESIZE_SSH_SLEEP:-3}
mkdir -p "$OUT" || exit 1
LOG=$OUT/run.log
ts() { date -u +%s.%N; }
since() { awk -v a="$1" -v b="$(ts)" 'BEGIN { printf "%.1f", b - a }'; }
log() { echo "$*" | tee -a "$LOG"; }
ssh_vm() {
  gcloud compute ssh "$VM" --project="$P" --zone="$Z" --quiet --command="$1" \
    -- -o ConnectTimeout=5 -o StrictHostKeyChecking=no
}
teardown() {
  local result=$? cleanup_rc
  trap - EXIT
  log "TEARDOWN_START $(date -u +%FT%TZ)"
  npx tsx scripts/agent-capacity/gcp-rails.ts teardown --run="$RUN" > "$OUT/teardown.log" 2>&1
  cleanup_rc=$?
  log "TEARDOWN_RC=$cleanup_rc $(date -u +%FT%TZ)"
  tail -n 6 "$OUT/teardown.log" | tee -a "$LOG"
  if [ "$cleanup_rc" -ne 0 ] && [ "$result" -eq 0 ]; then result=4; fi
  if [ "$result" -eq 0 ]; then log "DONE $(date -u +%FT%TZ)"; fi
  exit "$result"
}
trap teardown EXIT
log "RUN=$RUN VM=$VM from=$FROM to=$TO start $(date -u +%FT%TZ)"

npx tsx scripts/agent-capacity/gcp-rails.ts create --run="$RUN" --name="$VM" \
  --machine-type="$FROM" --max-hours=1 > "$OUT/create.log" 2>&1
RC=$?
log "CREATE_RC=$RC"
tail -n 4 "$OUT/create.log" | tee -a "$LOG"
# Nothing to measure on a VM that does not exist; the EXIT trap still tears down whatever was made.
[ "$RC" -eq 0 ] || { log "ABORT create failed"; exit 2; }

# Save provider evidence at every boundary. A successful command alone does not prove that the
# lifetime survived the update. Use creation time for the relative bound, conservatively earlier
# than lastStartTimestamp, and never admit a missing, expired, extended or non-DELETE schedule.
check_deadline() {
  local phase=$1 rc deadline
  gcloud compute instances describe "$VM" --project="$P" --zone="$Z" --format=json \
    > "$OUT/$phase.json" 2> "$OUT/$phase.err"
  rc=$?
  log "SCHEDULE_DESCRIBE_RC=$rc phase=$phase"
  [ "$rc" -eq 0 ] || { log "ABORT schedule describe failed ($phase)"; return "$rc"; }
  deadline=$(node - "$phase" "$OUT/$phase.json" "${DEADLINE:-}" "$TO" <<'NODE'
const fs = require('node:fs');
try {
  const [phase, file, expected, targetType] = process.argv.slice(2);
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'));
  const schedule = vm.scheduling;
  if (!schedule || schedule.instanceTerminationAction !== 'DELETE') throw Error('DELETE schedule required');
  const timestamp = value => {
    if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw Error('invalid timestamp');
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw Error('invalid timestamp');
    return time;
  };
  const bounds = [];
  if (schedule.terminationTime != null) bounds.push(timestamp(schedule.terminationTime));
  if (schedule.maxRunDuration != null) {
    if (phase !== 'initial') throw Error('relative lifetime was not cleared');
    const { seconds, nanos = 0 } = schedule.maxRunDuration;
    if (!/^[0-9]+$/.test(String(seconds)) || !Number.isSafeInteger(Number(seconds)) ||
        Number(seconds) <= 0 || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9) {
      throw Error('invalid maxRunDuration');
    }
    bounds.push(timestamp(vm.creationTimestamp) + Number(seconds) * 1000 + Math.floor(nanos / 1e6));
  }
  const deadline = Math.min(...bounds);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw Error('missing or expired deadline');
  if (expected && deadline !== timestamp(expected)) throw Error('original deadline changed');
  const status = phase === 'before-start' ? 'TERMINATED' : 'RUNNING';
  if (vm.status !== status) throw Error(`expected ${status} instance`);
  if (phase !== 'initial' && vm.machineType?.split('/').at(-1) !== targetType) throw Error('machine type mismatch');
  console.log(new Date(deadline).toISOString());
} catch (error) {
  console.error(`Unsafe VM deadline: ${error.message}`);
  process.exitCode = 1;
}
NODE
  )
  rc=$?
  [ "$rc" -eq 0 ] || { log "ABORT unsafe schedule ($phase)"; return "$rc"; }
  DEADLINE=$deadline
  log "DELETE_DEADLINE=$DEADLINE phase=$phase"
}
check_deadline initial || exit 5

wait_ssh() {
  local t0=$1 i
  for i in $(seq 1 "$SSH_TRIES"); do
    if ssh_vm true >/dev/null 2>&1; then
      log "SSH_OK after $(since "$t0") s (attempt $i)"
      return 0
    fi
    sleep "$SSH_SLEEP"
  done
  log "SSH_TIMEOUT after $SSH_TRIES attempts"
  return 1
}
wait_ssh "$(ts)" || exit 3
log "BOOT_UPTIME $(ssh_vm 'cat /proc/uptime; nproc; free -m | sed -n 2p' 2>/dev/null | tr '\n' ' ')"

# 1. Change the machine type while RUNNING (GCE refuses this for e2; the refusal text is the evidence).
T=$(ts)
gcloud compute instances set-machine-type "$VM" --project="$P" --zone="$Z" --machine-type="$TO" \
  > "$OUT/live-resize.log" 2>&1
log "LIVE_RESIZE_RC=$? after $(since "$T") s"
sed 's/^/LIVE_RESIZE_OUT /' "$OUT/live-resize.log" | head -n 8 | tee -a "$LOG"

# 2. The supported path: stop, change, start, then wait for the guest.
T0=$(ts)
gcloud compute instances stop "$VM" --project="$P" --zone="$Z" --quiet > "$OUT/stop.log" 2>&1
RC=$?
log "STOP_RC=$RC stop_s=$(since "$T0")"
[ "$RC" -eq 0 ] || { log "ABORT stop failed"; exit "$RC"; }
T=$(ts)
gcloud compute instances set-machine-type "$VM" --project="$P" --zone="$Z" --machine-type="$TO" \
  > "$OUT/set.log" 2>&1
RC=$?
log "SET_RC=$RC set_s=$(since "$T")"
[ "$RC" -eq 0 ] || { log "ABORT set-machine-type failed"; exit "$RC"; }
gcloud compute instances set-scheduling "$VM" --project="$P" --zone="$Z" --quiet \
  --clear-max-run-duration --termination-time="$DEADLINE" --instance-termination-action=DELETE \
  > "$OUT/schedule.log" 2>&1
RC=$?
log "SCHEDULE_RC=$RC"
[ "$RC" -eq 0 ] || { log "ABORT set-scheduling failed"; exit "$RC"; }
check_deadline before-start || exit 5
T=$(ts)
gcloud compute instances start "$VM" --project="$P" --zone="$Z" --quiet > "$OUT/start.log" 2>&1
RC=$?
log "START_RC=$RC start_s=$(since "$T")"
[ "$RC" -eq 0 ] || { log "ABORT start failed"; exit "$RC"; }
check_deadline after-start || exit 5
wait_ssh "$T0" || exit 3
log "OUTAGE_TOTAL_S $(since "$T0") (stop -> ssh reachable)"
log "AFTER $(ssh_vm 'nproc; free -m | sed -n 2p' 2>/dev/null | tr '\n' ' ')"
log "MACHINE_TYPE_NOW $TO RUNNING"

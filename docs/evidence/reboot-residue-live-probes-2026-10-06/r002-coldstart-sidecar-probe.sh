#!/usr/bin/env bash
# r002-coldstart-sidecar-probe.sh — EI-25222670171204378 / plan
# reboot-residue-service-repairs-2026-10-03 R-002 clause 3(d).
#
# Cold-starts the on-demand ornith llama-server through the inference gateway
# (no manual lever beyond stopping it first, which is the clause's
# precondition) while sampling the shared embed sidecar every 2s with a
# cache-bypassing /embed request. Answers two questions:
#   (a) does the embed sidecar keep running across the cold start
#       (ExecMainStartTimestamp / MainPID / NRestarts unchanged)?
#   (b) does ornith's load slow /embed past the watchdog's 15s probe deadline
#       (the inferred cause of the first failed probe on 2026-10-06 09:36Z)?
set -u
OUT_DIR="${1:-/tmp/r002-coldstart}"
mkdir -p "$OUT_DIR" || exit 1
SAMPLES="$OUT_DIR/embed-samples.tsv"
: > "$SAMPLES"
PRESSURE="$OUT_DIR/pressure.tsv"
printf 'time_utc\tio_some_avg10\tio_some_avg60\tio_full_avg10\tio_full_avg60\tmem_some_avg10\tmem_some_avg60\tmem_full_avg10\tmem_full_avg60\tglobal_pgmajfault\tglobal_refault_file\tglobal_pgscan_direct\tglobal_pgscan_kswapd\tglobal_pgsteal_direct\tglobal_pgsteal_kswapd\tsidecar_pgmajfault\tsidecar_refault_file\tsidecar_file_bytes\tsidecar_memory_current\tdata_disk\tdata_read_sectors\tdata_write_sectors\tgpu_used_mib\tgpu_free_mib\n' > "$PRESSURE"
TAIL_SEC="${R002_TAIL_SEC:-240}"

sidecar_state() {
  systemctl --user show papercup-embed-sidecar.service \
    -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStartTimestamp --value | paste -sd'|'
}

PRESSURE_CGROUP=$(systemctl --user show papercup-embed-sidecar.service -p ControlGroup --value 2>/dev/null || true)
PRESSURE_CGROUP_DIR="/sys/fs/cgroup$PRESSURE_CGROUP"
DATA_SOURCE=$(findmnt -n -o SOURCE -T /mnt/data 2>/dev/null || true)
DATA_DEVICE=$(basename "$DATA_SOURCE" 2>/dev/null || true)

psi_values() {
  awk '
    $1 == "some" { for (i=2; i<=NF; i++) { split($i, a, "="); if (a[1]=="avg10") s10=a[2]; if (a[1]=="avg60") s60=a[2] } }
    $1 == "full" { for (i=2; i<=NF; i++) { split($i, a, "="); if (a[1]=="avg10") f10=a[2]; if (a[1]=="avg60") f60=a[2] } }
    END { printf "%s|%s|%s|%s", s10, s60, f10, f60 }
  ' "$1" 2>/dev/null
}

vm_values() {
  awk '
    $1=="pgmajfault" { a=$2 }
    $1=="workingset_refault_file" { b=$2 }
    $1=="pgscan_direct" { c=$2 }
    $1=="pgscan_kswapd" { d=$2 }
    $1=="pgsteal_direct" { e=$2 }
    $1=="pgsteal_kswapd" { f=$2 }
    END { printf "%s|%s|%s|%s|%s|%s", a, b, c, d, e, f }
  ' /proc/vmstat
}

cgroup_values() {
  local stat_file="$PRESSURE_CGROUP_DIR/memory.stat"
  if [[ ! -r "$stat_file" ]]; then
    printf '||||'
    return
  fi
  local counters memory_current
  counters=$(awk '
    $1=="pgmajfault" { a=$2 }
    $1=="workingset_refault_file" { b=$2 }
    $1=="file" { c=$2 }
    END { printf "%s|%s|%s", a, b, c }
  ' "$stat_file")
  memory_current=$(cat "$PRESSURE_CGROUP_DIR/memory.current" 2>/dev/null || true)
  printf '%s|%s' "$counters" "$memory_current"
}

disk_values() {
  local counters
  counters=$(awk -v d="$DATA_DEVICE" '$3==d { printf "%s|%s", $6, $10; exit }' /proc/diskstats)
  printf '%s|%s' "$DATA_DEVICE" "$counters"
}

gpu_values() {
  nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader,nounits 2>/dev/null \
    | awk -F, '{ gsub(/ /, "", $1); gsub(/ /, "", $2); used+=$1; free+=$2; n++ } END { if (n) printf "%d|%d", used, free; else printf "|" }'
}

pressure_sampler() {
  local sample=0 ts io mem vm cg disk gpu
  while [[ ! -e "$STOP" ]]; do
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    io=$(psi_values /proc/pressure/io | tr '|' '\t')
    mem=$(psi_values /proc/pressure/memory | tr '|' '\t')
    vm=$(vm_values | tr '|' '\t')
    cg=$(cgroup_values | tr '|' '\t')
    disk=$(disk_values | tr '|' '\t')
    if (( sample % 5 == 0 )); then
      gpu=$(gpu_values | tr '|' '\t')
    else
      gpu=$(printf '\t')
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "$io" "$mem" "$vm" "$cg" "$disk" "$gpu" >> "$PRESSURE"
    sample=$((sample + 1))
    sleep 2
  done
}

T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "START $T0"
echo "PRE sidecar=$(sidecar_state)"
echo "PRE kokoro_start=$(systemctl --user show voicemode-kokoro.service -p ExecMainStartTimestamp --value)"
echo "PRE embed_device=$(sudo -n -u postgres psql -d papercusp -Atc 'select row_to_json(t) from harness_shared.operator_embed_device t' 2>&1 | head -1)"
echo "PRE gpu=$(nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader)"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | sed 's/^/PRE_GPU_APP /'

systemctl --user stop llama-ornith.service
echo "PRE ornith_after_stop=$(systemctl --user is-active llama-ornith.service)"

# Sampler: one cache-bypassing /embed every 2s until the stop file appears.
STOP="$OUT_DIR/stop"
rm -f "$STOP"
( pressure_sampler ) &
PRESSURE_SAMPLER=$!
(
  body='{"model":"gemma","kind":"query","texts":["r002-coldstart-sampler"],"bypassCache":true}'
  while [ ! -e "$STOP" ]; do
    ts=$(date -u +%H:%M:%S)
    res=$(curl -s -o "$OUT_DIR/last-embed.json" -w '%{http_code} %{time_total}' -m 30 \
      -H 'Content-Type: application/json' --data-binary "$body" http://127.0.0.1:3384/embed)
    ok=$(jq -e '(.vectors|arrays|length==1) and (.cache.inferred==1)' "$OUT_DIR/last-embed.json" >/dev/null 2>&1 && echo ok || echo bad)
    printf '%s\t%s\t%s\n' "$ts" "$res" "$ok" >> "$SAMPLES"
    sleep 2
  done
) &
SAMPLER=$!

sleep 10
S=$(date +%s)
CODE=$(curl -s -o "$OUT_DIR/completion.json" -w '%{http_code}' -m 900 http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"maxwell1500/ornith-35b:IQ3_M","max_tokens":16,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}')
echo "COMPLETION_HTTP=$CODE after $(( $(date +%s) - S ))s at $(date -u +%H:%M:%SZ)"
echo "COMPLETION_MODEL=$(grep -o '"model":"[^"]*"' "$OUT_DIR/completion.json" | head -1)"

# Keep sampling through several watchdog fires after the load settles.
sleep "$TAIL_SEC"
touch "$STOP"
wait "$SAMPLER"
wait "$PRESSURE_SAMPLER"

echo "POST sidecar=$(sidecar_state)"
echo "POST kokoro_start=$(systemctl --user show voicemode-kokoro.service -p ExecMainStartTimestamp --value)"
echo "POST ornith=$(systemctl --user is-active llama-ornith.service)"
echo "POST gpu=$(nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader)"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | sed 's/^/POST_GPU_APP /'
echo "SAMPLES_TOTAL=$(wc -l < "$SAMPLES")"
echo "SAMPLES_NON200=$(awk -F'\t' '{split($2,a," "); if (a[1]!="200") n++} END{print n+0}' "$SAMPLES")"
echo "SAMPLES_BAD_ACCOUNTING=$(awk -F'\t' '$3!="ok"{n++} END{print n+0}' "$SAMPLES")"
echo "SAMPLES_OVER_15S=$(awk -F'\t' '{split($2,a," "); if (a[2]+0>15) n++} END{print n+0}' "$SAMPLES")"
echo "SAMPLES_MAX_LATENCY_S=$(awk -F'\t' '{split($2,a," "); if (a[2]+0>m) m=a[2]+0} END{print m+0}' "$SAMPLES")"
echo "SAMPLES_P50_LATENCY_S=$(awk -F'\t' '{split($2,a," "); print a[2]+0}' "$SAMPLES" | sort -n | awk '{v[NR]=$1} END{print v[int((NR+1)/2)]}')"
echo "PRESSURE_SAMPLES_TOTAL=$(awk 'END{print NR-1}' "$PRESSURE")"
echo "PRESSURE_IO_SOME_AVG10_MAX=$(awk -F'\t' 'NR>1 && $2+0>m{m=$2+0} END{print m+0}' "$PRESSURE")"
echo "PRESSURE_IO_FULL_AVG10_MAX=$(awk -F'\t' 'NR>1 && $4+0>m{m=$4+0} END{print m+0}' "$PRESSURE")"
echo "PRESSURE_MEM_SOME_AVG10_MAX=$(awk -F'\t' 'NR>1 && $6+0>m{m=$6+0} END{print m+0}' "$PRESSURE")"
echo "PRESSURE_GLOBAL_PGMAJFAULT_DELTA=$(awk -F'\t' 'NR==2{first=$10} NR>1{last=$10} END{print last-first}' "$PRESSURE")"
echo "PRESSURE_GLOBAL_REFAULT_FILE_DELTA=$(awk -F'\t' 'NR==2{first=$11} NR>1{last=$11} END{print last-first}' "$PRESSURE")"
echo "PRESSURE_SIDECAR_PGMAJFAULT_DELTA=$(awk -F'\t' 'NR==2{first=$16} NR>1{last=$16} END{print last-first}' "$PRESSURE")"
echo "PRESSURE_SIDECAR_REFAULT_FILE_DELTA=$(awk -F'\t' 'NR==2{first=$17} NR>1{last=$17} END{print last-first}' "$PRESSURE")"
echo "PRESSURE_DATA_READ_SECTORS_DELTA=$(awk -F'\t' 'NR==2{first=$21} NR>1{last=$21} END{print last-first}' "$PRESSURE")"
echo "PRESSURE_GPU_USED_MIB_MAX=$(awk -F'\t' 'NR>1 && $23!="" && $23+0>m{m=$23+0} END{print m+0}' "$PRESSURE")"
echo "--- slowest 8 samples"
sort -t$'\t' -k2,2 "$SAMPLES" | awk -F'\t' '{split($2,a," "); print a[2]"\t"$0}' | sort -rn | head -8 | cut -f2-
echo "--- watchdog journal since $T0"
journalctl --user -u papercup-embed-sidecar-watchdog.service --since "$T0" --no-pager -o short-iso 2>/dev/null \
  | grep -vE 'Starting|Finished' | cut -c1-200 | head -20
echo "--- gateway journal since $T0 (ornith/audit/fail)"
journalctl --user -u papercup-inference-gateway.service --since "$T0" --no-pager -o short-iso 2>/dev/null \
  | grep -iE 'ornith|unit audit|on-demand|oom|out of memory|fail' | cut -c1-220 | head -12
echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"

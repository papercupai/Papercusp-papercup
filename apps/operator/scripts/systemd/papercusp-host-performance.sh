#!/usr/bin/env bash
# Persist the Papercusp shared Linux host's CPU policy across reboot.

set -euo pipefail

SYSFS_ROOT="${PAPERCUSP_CPU_SYSFS_ROOT:-/sys/devices/system/cpu/cpufreq}"
BLOCK_SYSFS_ROOT="${PAPERCUSP_BLOCK_SYSFS_ROOT:-/sys/block}"
NR_HUGEPAGES_REQUEST_PATH="${PAPERCUSP_NR_HUGEPAGES_REQUEST_PATH:-/proc/sys/vm/nr_hugepages}"
NR_HUGEPAGES_STATUS_PATH="${PAPERCUSP_NR_HUGEPAGES_STATUS_PATH:-$NR_HUGEPAGES_REQUEST_PATH}"
NR_HUGEPAGES_TARGET="${PAPERCUSP_NR_HUGEPAGES_TARGET:-18000}"
changed=0
seen=0

write_policy() {
  local file="$1" value="$2"
  [[ -e "$file" ]] || return 0
  printf '%s\n' "$value" >"$file"
  [[ "$(<"$file")" == "$value" ]] || {
    printf '[papercusp-host-performance] failed to set %s=%s\n' "$file" "$value" >&2
    return 1
  }
  changed=$((changed + 1))
}

configure_root_disk_scheduler() {
  local root_source disk_rows root_disks disk scheduler_file schedulers available selected

  if ! root_source="$(findmnt -nro SOURCE /)"; then
    printf '[papercusp-host-performance] failed to identify the root filesystem source\n' >&2
    return 1
  fi
  root_source="$(cut -d '[' -f 1 <<<"$root_source")"
  if ! disk_rows="$(lsblk --inverse --noheadings --raw --output KNAME,TYPE "$root_source")"; then
    printf '[papercusp-host-performance] failed to resolve root backing disks from %s\n' "$root_source" >&2
    return 1
  fi
  root_disks="$(awk '$2 == "disk" { print $1 }' <<<"$disk_rows" | sort -u)"
  [[ -n "$root_disks" ]] || {
    printf '[papercusp-host-performance] no backing disks found for root source %s\n' "$root_source" >&2
    return 1
  }

  while IFS= read -r disk; do
    [[ -n "$disk" ]] || continue
    scheduler_file="$BLOCK_SYSFS_ROOT/$disk/queue/scheduler"
    [[ -r "$scheduler_file" && -w "$scheduler_file" ]] || {
      printf '[papercusp-host-performance] root scheduler control is unavailable: %s\n' "$scheduler_file" >&2
      return 1
    }
    schedulers="$(<"$scheduler_file")"
    available="$(tr -d '[]' <<<"$schedulers")"
    [[ " $available " == *" mq-deadline "* ]] || {
      printf '[papercusp-host-performance] mq-deadline is unavailable for root disk %s (offered: %s)\n' "$disk" "$schedulers" >&2
      return 1
    }

    if [[ "$schedulers" != *"[mq-deadline]"* ]]; then
      printf '%s\n' mq-deadline >"$scheduler_file"
    fi
    selected="$(<"$scheduler_file")"
    [[ "$selected" == *"[mq-deadline]"* || "$selected" == mq-deadline ]] || {
      printf '[papercusp-host-performance] failed to select mq-deadline for root disk %s (read-back: %s)\n' "$disk" "$selected" >&2
      return 1
    }
    printf '[papercusp-host-performance] root I/O scheduler verified: %s via %s => %s\n' "$disk" "$root_source" "$selected"
  done <<<"$root_disks"
}

shopt -s nullglob
for policy in "$SYSFS_ROOT"/policy*; do
  [[ -d "$policy" ]] || continue
  seen=$((seen + 1))
  write_policy "$policy/scaling_governor" performance
  # amd-pstate-epp exposes a second, independent policy. A governor-only write
  # can leave this at balance_performance/power and keep clocks near base.
  write_policy "$policy/energy_performance_preference" performance
done

(( seen > 0 )) || {
  printf '[papercusp-host-performance] no cpufreq policies under %s\n' "$SYSFS_ROOT" >&2
  exit 1
}

printf '[papercusp-host-performance] performance policy verified on %d CPU policies (%d writes)\n' \
  "$seen" "$changed"

configure_root_disk_scheduler

# A 32 GiB shared_buffers allocation needs 16,384 x 2 MiB pages before
# PostgreSQL's other shared structures. Reserve 18,000 pages to leave explicit
# headroom before PostgreSQL starts. Linux can accept a write while allocating
# fewer pages when memory is fragmented, so the read-back is the authority:
# never let the unit look green when PG will silently fall back from
# huge_pages=try.
[[ "$NR_HUGEPAGES_TARGET" =~ ^[1-9][0-9]*$ ]] || {
  printf '[papercusp-host-performance] invalid huge-page target: %s\n' "$NR_HUGEPAGES_TARGET" >&2
  exit 1
}
[[ -e "$NR_HUGEPAGES_REQUEST_PATH" && -e "$NR_HUGEPAGES_STATUS_PATH" ]] || {
  printf '[papercusp-host-performance] huge-page control/status path missing: %s / %s\n' \
    "$NR_HUGEPAGES_REQUEST_PATH" "$NR_HUGEPAGES_STATUS_PATH" >&2
  exit 1
}

printf '%s\n' "$NR_HUGEPAGES_TARGET" >"$NR_HUGEPAGES_REQUEST_PATH"
reserved="$(<"$NR_HUGEPAGES_STATUS_PATH")"
[[ "$reserved" =~ ^[0-9]+$ ]] || {
  printf '[papercusp-host-performance] invalid huge-page read-back: %s\n' "$reserved" >&2
  exit 1
}
(( reserved >= NR_HUGEPAGES_TARGET )) || {
  printf '[papercusp-host-performance] huge-page reservation shortfall: reserved=%s required=%s; reboot before PostgreSQL starts so memory is unfragmented\n' \
    "$reserved" "$NR_HUGEPAGES_TARGET" >&2
  exit 1
}

printf '[papercusp-host-performance] huge-page reservation verified: reserved=%s required=%s\n' \
  "$reserved" "$NR_HUGEPAGES_TARGET"

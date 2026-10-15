#!/usr/bin/env bash
#
# Measure the first healthy :3070 response from the systemd user-manager start.
# A user-level timer runs this independently of default.target, so an operator
# unit accidentally ordered After=default.target cannot hide behind that target
# while every other boot job finishes.

set -uo pipefail

SCRIPT_NAME="${0##*/}"
TARGET_UID="${PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_UID:-1000}"
GRACE_SEC="${PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_GRACE_SEC:-600}"
PORT="${PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_PORT:-3070}"
STATE_DIR="${PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_STATE_DIR:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/papercusp-operator-boot-availability}"
NOW_USEC="${PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_NOW_USEC:-}"

fail() {
  echo "[$SCRIPT_NAME] ERROR: $*" >&2
  exit 2
}

for setting in TARGET_UID GRACE_SEC PORT; do
  value="${!setting}"
  case "$value" in
    ''|*[!0-9]*) fail "$setting must be a positive integer (got '$value')" ;;
  esac
  (( value > 0 )) || fail "$setting must be greater than zero"
done

command -v systemctl >/dev/null 2>&1 || fail "systemctl is unavailable"
command -v curl >/dev/null 2>&1 || fail "curl is unavailable"

if [[ -z "$NOW_USEC" ]]; then
  uptime_seconds="$(awk '{ print $1 }' /proc/uptime 2>/dev/null)" || fail "could not read monotonic uptime"
  NOW_USEC="$(awk -v seconds="$uptime_seconds" 'BEGIN { if (seconds !~ /^[0-9]+([.][0-9]+)?$/) exit 1; printf "%.0f", seconds * 1000000 }')" ||
    fail "could not convert monotonic uptime to microseconds"
fi
case "$NOW_USEC" in
  ''|*[!0-9]*) fail "monotonic time must be a non-negative integer (got '$NOW_USEC')" ;;
esac

UNIT="user@${TARGET_UID}.service"
manager_props="$(systemctl show "$UNIT" --property=ActiveState --property=ActiveEnterTimestampMonotonic --no-pager)" ||
  fail "could not read ActiveState and ActiveEnterTimestampMonotonic for $UNIT"
manager_state=""
manager_started_usec=""
while IFS='=' read -r key value; do
  case "$key" in
    ActiveState) manager_state="$value" ;;
    ActiveEnterTimestampMonotonic) manager_started_usec="$value" ;;
  esac
done <<<"$manager_props"

if [[ "$manager_state" != active ]]; then
  echo "[$SCRIPT_NAME] waiting: $UNIT is ${manager_state:-unknown}; manager start has not begun"
  exit 0
fi
case "$manager_started_usec" in
  ''|*[!0-9]*) fail "$UNIT has no valid ActiveEnterTimestampMonotonic" ;;
esac
(( manager_started_usec > 0 )) || fail "$UNIT has no valid ActiveEnterTimestampMonotonic"
(( NOW_USEC >= manager_started_usec )) || fail "monotonic clock precedes $UNIT start time"

elapsed_sec=$(((NOW_USEC - manager_started_usec) / 1000000))
READY_FILE="$STATE_DIR/manager-${TARGET_UID}.ready"
ALERT_FILE="$STATE_DIR/manager-${TARGET_UID}.alerted"

read_marker() {
  local value=""
  if [[ -r "$1" ]]; then IFS= read -r value <"$1" || true; fi
  printf '%s' "$value"
}

write_marker() {
  local path="$1" value="$2" tmp="$1.$$"
  printf '%s\n' "$value" >"$tmp" || fail "could not write $tmp"
  chmod 0600 "$tmp" || fail "could not secure $tmp"
  mv -f -- "$tmp" "$path" || fail "could not publish $path"
}

mkdir -p -- "$STATE_DIR" || fail "could not create state directory $STATE_DIR"

ready_for_manager="$(read_marker "$READY_FILE")"
if [[ "$ready_for_manager" == "$manager_started_usec" ]]; then
  echo "[$SCRIPT_NAME] skip: :${PORT} boot readiness was already proved for this user-manager start"
  exit 0
fi

if curl --silent --show-error --fail --connect-timeout 1 --max-time 2 \
  "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  write_marker "$READY_FILE" "$manager_started_usec"
  rm -f -- "$ALERT_FILE" || fail "could not clear $ALERT_FILE"
  if (( elapsed_sec > GRACE_SEC )); then
    echo "[$SCRIPT_NAME] healthy now: :${PORT}/api/health first succeeded at a ${elapsed_sec}s sample; the ${GRACE_SEC}s startup window was not observed"
  else
    echo "[$SCRIPT_NAME] healthy: :${PORT}/api/health first succeeded at ${elapsed_sec}s after $UNIT started"
  fi
  exit 0
fi

if (( elapsed_sec < GRACE_SEC )); then
  echo "[$SCRIPT_NAME] pending: :${PORT}/api/health is not healthy ${elapsed_sec}s after $UNIT start (< ${GRACE_SEC}s grace)"
  exit 0
fi

alerted_for_manager="$(read_marker "$ALERT_FILE")"
if [[ "$alerted_for_manager" == "$manager_started_usec" ]]; then
  # Keep probing once a minute, but emit only the first alarm for this manager
  # lifetime. The next healthy sample clears it; a manager restart gets a new key.
  exit 1
fi

write_marker "$ALERT_FILE" "$manager_started_usec"
echo "[$SCRIPT_NAME] ALERT: :${PORT}/api/health is still unavailable ${elapsed_sec}s after $UNIT started (grace: ${GRACE_SEC}s)" >&2
exit 1

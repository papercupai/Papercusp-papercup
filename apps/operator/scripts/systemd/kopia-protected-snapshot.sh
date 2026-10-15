#!/usr/bin/env bash
# Supported manual/protected snapshot entrypoint. It waits for every scheduled
# or daily Kopia snapshot to leave the shared guard before starting.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 SOURCE [SOURCE ...]" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=kopia-cache-bootstrap.sh
source "$script_dir/kopia-cache-bootstrap.sh"
guard="${KOPIA_BACKUP_GUARD_BIN:-$script_dir/kopia-backup-guard.sh}"
[ -x "$guard" ] || { echo "Kopia backup guard is not executable: $guard" >&2; exit 69; }

renice 19 -p $$ >/dev/null 2>&1 || true
ionice -c3 -p $$ >/dev/null 2>&1 || true

if [ "${KOPIA_BACKUP_GUARD_ACTIVE:-0}" != 1 ]; then
  exec "$guard" --mode wait --label protected-manual -- "$0" "$@"
fi

KOPIA_BIN="${KOPIA_PROTECTED_SNAPSHOT_BIN:-/usr/bin/kopia}"
SUDO_BIN="${KOPIA_PROTECTED_SNAPSHOT_SUDO:-/usr/bin/sudo}"
kopia_retention_pin_all "$SUDO_BIN" "$KOPIA_BIN" add || exit $?
kopia_as_root "$SUDO_BIN" "$KOPIA_BIN" snapshot create "--pin=$KOPIA_RETENTION_PIN" "$@" || exit $?
kopia_retention_finish "$SUDO_BIN" "$KOPIA_BIN"


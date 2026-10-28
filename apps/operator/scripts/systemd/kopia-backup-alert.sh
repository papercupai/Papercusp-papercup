#!/usr/bin/env bash
# Backup alarm — EI-10733.
#
# The old failure was not that nobody CHECKED; kopia-healthcheck.service has been
# exiting 1 every 15 minutes for weeks. It was that a failing systemd oneshot with
# no OnFailure= notifies NOBODY: the alarm rang in an empty room for 30 days while
# `notify-send` fired into a headless box.
#
# So this writes the alarm where a human OR an agent will actually trip over it:
# a marker file in the backup dir, a journal error, the fleet's coord inbox
# (best-effort — the operator may itself be down, which is exactly when backups
# matter most, so nothing here may be fatal).
#
# ── WHY THIS FILE IS NOW REPO-TRACKED (WI-2146225, 2026-09-05) ───────────────
# It used to live ONLY as an untracked ~/.config/kopia/backup-alert.sh — the sole
# one of the three kopia scripts that was not a symlink into the tree, and exactly
# the thing papercusp-db-backup.sh's own header warns against ("do not restore an
# untracked ~/.config/kopia/db-backup.sh copy"). Untracked meant it silently
# missed the WI-2145150 dump relocation while every tracked consumer was updated.
#
# ── THE BUG THAT FIXED (WI-2145397 class) ───────────────────────────────────
# DUMP was HARDCODED to /mnt/data/Backup/db-dumps with no environment variable at
# all. After the relocation to /mnt/backup that made this alarm write its marker,
# and print its triage commands, for the ONE directory nothing writes any more:
# the responder is told to `tail $DUMP/db-backup.log` and reads a log frozen at
# the moment of the move. An alarm that points at the wrong evidence is worse than
# no alarm — it costs a responder a full false triage, which is precisely what
# happened to three agents inside thirty minutes on papercup-backup-health.
set -uo pipefail

# Resolve the same way every other consumer does. The fallback is the CURRENT
# path, not the abandoned one: a fallback is what runs when the unit forgot to set
# the variable, so it must be the answer that is right rather than the historical
# one. papercusp-db-backup-alert.service sets it explicitly (asserted by
# apps/operator/scripts/__tests__/backup-dump-dir-env-contract.test.ts).
DUMP="${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/cold-a/Backup/db-dumps}"
MARKER="$DUMP/ALERT-BACKUP-FAILING"
REASON="${1:-papercusp-db-backup.service failed}"

# Derive the repo from THIS FILE's own location — never a hardcoded home path.
# A literal /home/<user>/... in shipped source reds the green-checkpoint
# identity-lint leg and freezes `main` for the whole fleet, and is simply wrong on
# every machine but one. readlink -f first: the unit invokes this through the
# ~/.config/kopia symlink, so $0's directory is not inside any git repo.
SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
REPO="$(git -C "$(dirname "$SELF")" rev-parse --show-toplevel 2>/dev/null || true)"

mkdir -p "$DUMP"
{
  echo "BACKUP ALARM — $(date -Iseconds)"
  echo "$REASON"
  echo
  echo "The Postgres backup is not producing usable dumps."
  echo "This exact condition went unnoticed for 30 days (2026-06-12 -> 2026-07-12, EI-10733)."
  echo
  echo "Triage:"
  echo "  systemctl --user status papercusp-db-backup.service"
  echo "  tail -40 $DUMP/db-backup.log"
  echo "  cat $DUMP/STATUS.json"
  echo "  ${REPO:-\$REPO}/apps/operator/scripts/systemd/papercusp-db-backup.sh   # run it by hand, read the errors"
  echo "    (that script is REPO-TRACKED; the old ~/.config/kopia/db-backup.sh path is DEAD,"
  echo "     do not restore an untracked copy)"
  echo
  echo "  A 'SKIPPED — needs ~N GiB ... only M GiB free' line is NOT a dump error:"
  echo "  it is the headroom guard refusing correctly. The repair is to RECLAIM SPACE."
  echo "  Do NOT lower PC_BACKUP_MIN_FREE_GB/PC_BACKUP_SPACE_SAFETY and do NOT add"
  echo "  pg_dump -Z compression (it defeats Kopia dedup) — both are forbidden in-script."
  echo
  echo "  A '*-state' or '*-transcript' entry in STATUS.json tierFailed is NOT this alarm:"
  echo "  those tiers are deliberately excluded from ok/failed (WI-2146225) because during"
  echo "  the additive phase they are redundant copies of an authoritative dump that is"
  echo "  already green. If ONLY tierFailed is non-empty, the backup is fine."
} > "$MARKER"

echo "BACKUP ALARM: $REASON (see $MARKER)" >&2   # -> journal

command -v notify-send >/dev/null && notify-send -u critical "Papercusp backup FAILING" "$REASON" 2>/dev/null || true

# Best-effort: raise it to the fleet so an agent sees it even if no human is at the box.
if [ -n "$REPO" ] && [ -f "$REPO/scripts/mcp-call.mjs" ]; then
  # coord:send REQUIRES `expects`, and `body` must be an ARRAY of sections — a plain
  # string is refused. This leg sent a string body and no `expects` from 2026-07-12
  # until 2026-09-05, so EVERY alarm was rejected with invalid_args and the failure
  # was swallowed by `>/dev/null 2>&1 || true`: the fleet was never told. That is
  # EI-10733's own failure shape (an alarm ringing in an empty room) wearing a new
  # costume — which is why the suppression below is deliberately NOT restored.
  BODY=$(node -e '
    const [reason, marker, dump] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      to: ["*"],
      expects: "none",
      conditionKey: "papercusp-db-backup-failing",
      summary: "BACKUP FAILING: " + reason,
      body: [{
        text: "papercusp-db-backup is not producing usable dumps. See " + marker +
          " and " + dump + "/db-backup.log. EI-10733 is the last time this rotted silently — for 30 days."
      }]
    }));
  ' "$REASON" "$MARKER" "$DUMP")
  # Non-fatal (the operator may itself be down — exactly when backups matter most),
  # but NEVER silent: stderr goes to the journal so a broken leg is visible.
  if ! (cd "$REPO" && timeout 30 node scripts/mcp-call.mjs coord:send "$BODY" \
      --client system-backup-alert --harness papercusp --workspace papercusp-workspace >/dev/null); then
    echo "BACKUP ALARM: coord:send leg FAILED — fleet NOT notified; marker file is $MARKER" >&2
  fi
fi
exit 0

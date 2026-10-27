#!/usr/bin/env bash
# Kopia / backup healthcheck.
#
# ── WHY THIS WAS REWRITTEN (EI-10733, 2026-07-12) ───────────────────────────
# The old version asserted ONLY that a kopia SNAPSHOT had run recently. That is
# the check that let the Postgres backup rot for THIRTY DAYS in plain sight:
# kopia faithfully re-snapshotted the SAME 30-day-old pg-5432.sql.gz every 5
# minutes, so "last snapshot 3 minutes ago" stayed true and green the whole
# time — while the payload inside it was a month stale and every dump had been
# failing since 2026-06-12.
#
# Snapshot recency is not backup health. A backup is healthy only if its CONTENT
# is fresh and RESTORABLE. So this asserts on the DUMP ITSELF and treats
# snapshot recency as the secondary signal it always was.
#
# Deliberately implementation-agnostic: it accepts freshness from EITHER dump
# system (db-backup.sh's STATUS.json, or pre-snapshot.sh's pg-5432.sql.gz), so
# it keeps working whichever one we converge on.
#
# ── WHY THE ALARM IS NOW TEST-SAFE BY CONSTRUCTION (EI-10746, 2026-07-12) ────
# The rewrite above made the alert command injectable (BACKUP_ALERT_CMD) with exactly
# the right intent, stated in its own comment: "testable without broadcasting a false
# alarm to the fleet". But the mechanism was OPT-IN and nothing enforced it — so the
# DEFAULT way to test the alarm was to ring it for real.
#
# That is not hypothetical. At 22:25:07 on 2026-07-12, three failure-path test runs —
# against a dump that was FOUR MINUTES OLD and perfectly healthy — each invoked the real
# backup-alert.sh, which coord:sends a critical "BACKUP FAILING" to ["*"]. It paged the
# whole fleet and pulled a working agent off its lane to investigate a data-loss event
# that was not happening. An alarm that cries wolf is not a lesser bug than one that
# stays silent: it is how the NEXT real alarm gets ignored — which is precisely how the
# 30-day outage above went unnoticed for 30 days.
#
# An opt-in guard that must be REMEMBERED is not a guard. So the rule is now structural:
# OVERRIDING A THRESHOLD IS THE DEFINITION OF A NON-PRODUCTION RUN. If MAX_DUMP_AGE_S /
# MAX_SNAP_AGE_S is set in the environment, or sits below a floor no real hourly backup
# would ever use, the BROADCAST is withheld — loudly, with the exit code UNCHANGED, so
# the failure path is still fully exercised and the verdict is still honest. There is
# nothing to remember. BACKUP_ALERT_FORCE=1 pages anyway, for the rare case a non-default
# threshold genuinely should.
#
# The guard must DISCRIMINATE, not merely mute — a suppressor that also silences the real
# alarm is just a broken alarm with better manners. `healthcheck.sh --self-test` proves
# BOTH directions. Run it after touching fail().
set -uo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=kopia-cache-bootstrap.sh
source "$script_dir/kopia-cache-bootstrap.sh"
LOG_DIR="${KOPIA_HEALTHCHECK_LOG_DIR:-$HOME/.cache/kopia}"
if ! ensure_kopia_cache_dir "$LOG_DIR"; then
  echo "FATAL: unable to bootstrap Kopia healthcheck log directory: $LOG_DIR" >&2
  exit 1
fi
LOG="$LOG_DIR/healthcheck.log"
# WI-2145150: follow the SAME env seam papercusp-db-backup.sh:60 uses, so this
# assertion measures the tree the backup actually writes. Hardcoding it here meant
# a relocated dump left the freshness check pointed at a directory nothing updates.
# The fallback is unchanged, so a host that never overrides the var is unaffected.
# Current fallback follows the cold-a destination in papercusp-db-backup.sh.
# A health check must read the producer's tree, not the retained legacy copy.
DUMP="${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/cold-a/Backup/db-dumps}"
STATUS="$DUMP/STATUS.json"
SUDO_BIN="${KOPIA_HEALTHCHECK_SUDO:-/usr/bin/sudo}"
KOPIA_BIN="${KOPIA_HEALTHCHECK_BIN:-/usr/bin/kopia}"
# Injectable so a caller can capture the alert instead of firing it. This is now a
# convenience for tests, NOT the safety mechanism — see ALARM SAFETY below.
ALERT="${BACKUP_ALERT_CMD:-$HOME/.config/kopia/backup-alert.sh}"

# ── ALARM SAFETY (EI-10746) — decide BEFORE the defaults are applied ─────────
# `${VAR:-default}` erases the difference between "unset" and "set to the default value",
# so the override has to be detected HERE, while `${VAR+x}` can still see it.
MIN_SANE_DUMP_AGE_S=600     # 10m. The backup runs hourly; no real bar is below this.
ALARM_SUPPRESSED=""
if [ -z "${BACKUP_ALERT_FORCE:-}" ]; then
  if [ -n "${MAX_DUMP_AGE_S+x}" ] || [ -n "${MAX_SNAP_AGE_S+x}" ] || [ -n "${MAX_ODDSMITH_DUMP_AGE_S+x}" ] || [ -n "${MAX_HOME_SNAP_AGE_S+x}" ] || [ -n "${MAX_DUMP_RUN_S+x}" ]; then
    ALARM_SUPPRESSED="a threshold was overridden in the environment (MAX_DUMP_AGE_S/MAX_SNAP_AGE_S/MAX_ODDSMITH_DUMP_AGE_S/MAX_HOME_SNAP_AGE_S/MAX_DUMP_RUN_S) — that is a TEST run, not production"
  fi
fi

# 8h — deliberately LONGER than the repo alarm's 6h. Since the EI-10733 convergence
# there are two backup-health checks, and they must not DISAGREE (one red, one green,
# for the same event — confusing whoever investigates). apps/operator/scripts/
# papercup-backup-health-check.sh is the PRIMARY DB-dump freshness alarm: 6h bar, and
# it FILES AN EI (the richer, owner-visible escalation). This kopia-local check is a
# second-tier BACKSTOP on a different channel (coord broadcast), so its bar sits
# strictly beyond the primary's — the EI-filer always fires first, and this only speaks
# up if a stale backup somehow went 8h without that EI being acted on.
MAX_DUMP_AGE_S="${MAX_DUMP_AGE_S:-28800}"   # 8h backstop (primary alarm = repo script @ 6h)
MAX_SNAP_AGE_S="${MAX_SNAP_AGE_S:-3600}"     # 30m cadence: tolerate one missed cycle plus runtime/jitter; also caps the exact dump source below
# 90% of the hourly db-backup timer period; see the duty-cycle check at the end (WI-10004603).
MAX_DUMP_RUN_S="${MAX_DUMP_RUN_S:-3240}"

# 48h — $HOME is a DAILY source (kopia-home-snapshot.timer), so its bar is
# "two consecutive missed runs", by the same reasoning MAX_ODDSMITH_DUMP_AGE_S uses for its
# own cadence: one miss is a blip (a reboot, or a run the flock skipped because the previous
# one overran), two is a fault. It must NOT reuse MAX_SNAP_AGE_S's 3600s — that bar measures
# a 30-MINUTE cadence and would page against this source every single day.
MAX_HOME_SNAP_AGE_S="${MAX_HOME_SNAP_AGE_S:-172800}"
# The daily VM leg records a source-bound verification marker after Kopia exits
# successfully, including its "no files have been changed" result.  A fresh
# marker is evidence that the timer ran and verified the source even when Kopia
# correctly emitted no new snapshot row.
VM_VERIFY_MARKER="${KOPIA_VM_VERIFY_MARKER:-$LOG_DIR/macos-vm-verified}"

# 12h — the oddsmith embedded PG (5544) is dumped by its own leg in db-backup.sh
# (WI-39502) and asserted SEPARATELY here. Looser than the cluster bar on purpose:
# the oddsmith sidecar is a restartable service that can legitimately be down for a
# while, and its leg SKIPS rather than fails when the server is unreachable, so a
# short outage must not page. Twelve consecutive hourly misses is no longer a blip —
# either the sidecar has been down half a day or the leg itself is broken, and both
# mean the database is accumulating unbacked-up state. This bar exists because on
# 2026-08-15 that database was destroyed with no dump in existence and NOTHING
# noticed: the failure mode being detected here is silent ABSENCE, which no restore
# drill can catch, because there was never an artifact to drill against.
MAX_ODDSMITH_DUMP_AGE_S="${MAX_ODDSMITH_DUMP_AGE_S:-43200}"

# ── ALERT DEDUP / BACKOFF (EI-12010) ─────────────────────────────────────────
# fail() used to invoke $ALERT UNCONDITIONALLY every time this ran — and this timer
# fires every 15 MINUTES (kopia-healthcheck.timer). While one condition stayed red,
# that meant a fresh fleet-wide `coord:send { to:["*"] }` broadcast every single tick:
# measured live, 7 near-identical "system-backup-alert" broadcasts in 30 minutes,
# climbing for 19+ hours on ONE ongoing incident (EI-12010). "Do not poll" applies to
# alarms too — a peer that already saw this alarm does not need to see it again every
# 15 minutes for the SAME still-open condition.
#
# Mirrors the RED_MARKER dedup pattern apps/operator/scripts/papercup-backup-health-check.sh
# already uses for its own EI-filing path (same file family, same incident, EI-10733)
# — reused rather than reinvented. Same EI-10746 discrimination rule applies here too:
# the marker is written ONLY on a run that actually pages (inside the non-suppressed,
# non-deduped branch of fail()), never on a suppressed/deduped no-op — a marker written
# on a no-op would silently disarm the NEXT real page for the whole refile window,
# which is precisely the class of bug EI-10746 exists to prevent.
HEALTHCHECK_STATE_DIR="${HEALTHCHECK_STATE_DIR:-$HOME/.papercusp/backup-health}"
mkdir -p "$HEALTHCHECK_STATE_DIR" 2>/dev/null || true
# 4h: this is a BACKSTOP alarm (see the MAX_DUMP_AGE_S comment above) — it may re-page
# less eagerly than the primary EI-filer without an ongoing incident ever going silent
# for a whole shift. BACKUP_ALERT_FORCE=1 bypasses the dedup window too (a forced page
# always pages, exactly like it already bypasses ALARM_SUPPRESSED above).
ALERT_REFILE_S="${ALERT_REFILE_S:-14400}"

# Floor check, applied AFTER the defaults: catches an absurd threshold baked into a
# caller or a systemd unit rather than passed in the env. A 0s/1s/60s staleness bar
# cannot be a real production value for an hourly backup — it can only be a test.
if [ -z "$ALARM_SUPPRESSED" ] && [ -z "${BACKUP_ALERT_FORCE:-}" ] \
   && [ "$MAX_DUMP_AGE_S" -lt "$MIN_SANE_DUMP_AGE_S" ] 2>/dev/null; then
  ALARM_SUPPRESSED="MAX_DUMP_AGE_S=${MAX_DUMP_AGE_S}s is below the ${MIN_SANE_DUMP_AGE_S}s sanity floor — no hourly backup has that bar; treating as a TEST run"
fi

now=$(date +%s)

# Render a duration in units a reader can act on (EI-10746). Integer-dividing by 3600
# rendered EVERY sub-hour threshold as "0h", producing the literal line:
#     "Postgres dump is STALE: 0h 4m old (limit 0h)"
# — from which the real threshold is UNRECOVERABLE, and which reads like a monitor that
# has lost its mind. A threshold the message cannot express is one it must not print.
dur() {
  local s="${1:-0}"
  if   [ "$s" -ge 3600 ]; then echo "$(( s / 3600 ))h $(( (s % 3600) / 60 ))m"
  elif [ "$s" -ge 60 ];   then echo "$(( s / 60 ))m"
  else                         echo "${s}s"
  fi
}

# Extract ONE exact source's block from `kopia snapshot list <path>` output.
# Kopia may print an ancestor-source <ERROR> block first, then the valid exact
# source block (observed for $HOME/macos-vm). A global `<ERROR>`
# grep therefore turns a healthy exact snapshot red. Headers are unindented;
# detail rows are indented, so keep only the block whose header ends in :$src.
exact_source_block() {
  local src="$1"
  awk -v src="$src" '
    /^[^[:space:]]/ {
      suffix = ":" src
      active = length($0) >= length(suffix) && substr($0, length($0) - length(suffix) + 1) == suffix
    }
    active { print }
  '
}

vm_verification_epoch() {
  local marker="$1" source="$2" verified_at="" verified_source=""
  [ -r "$marker" ] || return 1
  verified_at="$(sed -n 's/^verified_at=\([0-9][0-9]*\)$/\1/p' "$marker" | head -1)"
  verified_source="$(sed -n 's/^source=//p' "$marker" | head -1)"
  [[ "$verified_at" =~ ^[0-9]+$ ]] || return 1
  [ "$verified_source" = "$source" ] || return 1
  printf '%s\n' "$verified_at"
}

fail() {
  # Carry the section-0 leftover finding on EVERY page, not only its own (WI-6554700010011924).
  [ -z "${LEFTOVER_NOTE:-}" ] || set -- "$* $LEFTOVER_NOTE"
  echo "[$(date -Iseconds)] FAIL: $*" >> "$LOG"
  if [ -n "$ALARM_SUPPRESSED" ]; then
    # The exit code stays 1 — the failure path is fully exercised and the verdict is real.
    # ONLY the fleet-wide broadcast is withheld. That is the entire point: a test gets the
    # truth without waking every agent on the box.
    echo "[$(date -Iseconds)] ALARM SUPPRESSED ($ALARM_SUPPRESSED) — would have broadcast: $*" >> "$LOG"
    {
      echo "ALARM SUPPRESSED — nothing was broadcast to the fleet."
      echo "  reason:  $ALARM_SUPPRESSED"
      echo "  verdict: FAIL — $*"
      echo "  (this run still exits 1; set BACKUP_ALERT_FORCE=1 to page the fleet anyway)"
    } >&2
  else
    local marker="$HEALTHCHECK_STATE_DIR/last-alert"
    local last=0
    [ -f "$marker" ] && last="$(cat "$marker" 2>/dev/null || echo 0)"
    local since=$(( now - last ))
    # NOTE: BACKUP_ALERT_FORCE is deliberately NOT consulted here — it bypasses the
    # test-vs-production ALARM_SUPPRESSED gate above, not the anti-spam dedup window.
    # Mirrors papercup-backup-health-check.sh's RED_MARKER, which dedupes regardless
    # of a force override too — "force" means "don't treat this as a test", not
    # "ignore the anti-spam window".
    if [ "$since" -lt "$ALERT_REFILE_S" ] 2>/dev/null; then
      echo "[$(date -Iseconds)] ALERT DEDUPED (last paged $(dur "$since") ago < $(dur "$ALERT_REFILE_S") refile window) — would have broadcast: $*" >> "$LOG"
    else
      # WI-10002566: this was `[ -x "$ALERT" ] && "$ALERT" "$*"`, which short-circuits to
      # SILENCE when the alarm script is not executable — no page, no error, no journal
      # line — and then recorded a page in "$marker" anyway, suppressing REAL alarms for
      # the next ALERT_REFILE_S. kopia-backup-alert.sh sat at mode 100644 from 2026-09-05
      # until 2026-09-22 and this alarm was inert for all 17 days, which is EI-10733's own
      # failure (an alarm ringing in an empty room) wearing a permission bit as a costume.
      # Three rules follow, and the third is the one that was actually load-bearing:
      #   1. page anyway, through the interpreter — a wrong mode must not cost a page;
      #   2. say so LOUDLY, to both the log and the journal, so the mode gets fixed;
      #   3. never record a page that did not happen, or the dedup window hides the next one.
      if [ -x "$ALERT" ]; then
        "$ALERT" "$*"
        echo "$now" > "$marker"
      elif [ -f "$ALERT" ]; then
        echo "[$(date -Iseconds)] ALARM SCRIPT NOT EXECUTABLE: $ALERT — paged via bash anyway; fix its mode (chmod 755)" | tee -a "$LOG" >&2
        bash "$ALERT" "$*"
        echo "$now" > "$marker"
      else
        echo "[$(date -Iseconds)] ALARM SCRIPT MISSING: $ALERT — NOBODY WAS PAGED; deliberately NOT recording a page, so the next run retries instead of deduping against a page that never went out" | tee -a "$LOG" >&2
      fi
    fi
  fi
  exit 1
}

# ── SELF-TEST: prove the guard DISCRIMINATES (EI-10746) ─────────────────────
# Not a smoke test. It asserts BOTH directions, because either alone is worthless:
#   - suppress-on-test, but never fire   => an alarm that cannot ring (a mute button)
#   - fire-on-force, but also on a test  => the false-alarm bug, unfixed
# A guard is only a guard if it fires when it should AND stays silent when it shouldn't.
# The real backup-alert.sh is never invoked here: every case injects a recording stub.
if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  stub="$tmp/alert-stub.sh"
  printf '#!/usr/bin/env bash\necho "$*" >> "%s/paged"\n' "$tmp" > "$stub"
  chmod +x "$stub"
  # Same stub, deliberately NOT executable — the production state that disarmed this
  # alarm for 17 days (WI-10002566). Used by case 2b below.
  stub_noexec="$tmp/alert-stub-noexec.sh"
  printf '#!/usr/bin/env bash\necho "$*" >> "%s/paged"\n' "$tmp" > "$stub_noexec"
  chmod 644 "$stub_noexec"
  self="${BASH_SOURCE[0]}"
  pass=0; failed=0
  check() { # <name> <want-exit> <want-paged:yes|no> [ENV=VAL ...]
    local name="$1" want_exit="$2" want_paged="$3"; shift 3
    rm -f "$tmp/paged"
    # EI-12010: an isolated, FRESH state dir per check — otherwise every check would
    # default to the real $HOME/.papercusp/backup-health (polluting live host state)
    # AND the new dedup window would make check N's page suppress check N+1's.
    rm -rf "$tmp/state"; mkdir -p "$tmp/state"
    # KOPIA_UNIT_CGROUP_ROOT: never read the host's real unit cgroups from a self-test
    # (a live leftover there would flip an unrelated case; WI-6554700010011924).
    env BACKUP_ALERT_CMD="$stub" HEALTHCHECK_STATE_DIR="$tmp/state" \
        KOPIA_UNIT_CGROUP_ROOT="$tmp/no-unit-cgroups" "$@" bash "$self" >/dev/null 2>&1
    local got_exit=$?
    local got_paged=no; [ -s "$tmp/paged" ] && got_paged=yes
    if [ "$got_exit" = "$want_exit" ] && [ "$got_paged" = "$want_paged" ]; then
      printf '  ok    %s (exit %s, paged=%s)\n' "$name" "$got_exit" "$got_paged"; pass=$((pass+1))
    else
      printf '  FAIL  %s — wanted exit=%s paged=%s, got exit=%s paged=%s\n' \
        "$name" "$want_exit" "$want_paged" "$got_exit" "$got_paged"; failed=$((failed+1))
    fi
  }
  echo "healthcheck.sh --self-test — EI-10746 alarm discrimination"
  # 1. THE BUG THAT ACTUALLY HAPPENED: exercising the failure path must NOT page the
  #    fleet — while still reporting the failure honestly through the exit code.
  check "tightened threshold FAILS but does NOT page the fleet"   1 no  MAX_DUMP_AGE_S=1
  # 2. THE OVER-CORRECTION THIS MUST NOT BECOME: the alarm must still be able to fire.
  check "tightened threshold + BACKUP_ALERT_FORCE=1 DOES page"    1 yes MAX_DUMP_AGE_S=1 BACKUP_ALERT_FORCE=1
  # 2b. WI-10002566: A WRONG FILE MODE MUST NOT COST A PAGE. kopia-backup-alert.sh sat at
  #     100644 from 2026-09-05 to 2026-09-22; the old `[ -x "$ALERT" ] &&` short-circuited
  #     to silence, so this alarm was inert for 17 days while looking healthy. Note WHY the
  #     cases above never caught it: they all inject a stub the harness itself chmod +x'd,
  #     so the one property that broke in production was the one property never varied.
  #     This case injects a deliberately NON-EXECUTABLE stub instead.
  check "NON-executable alarm script STILL pages"                1 yes MAX_DUMP_AGE_S=1 BACKUP_ALERT_FORCE=1 BACKUP_ALERT_CMD="$stub_noexec"
  # 3. THE EXACT BUG FROM EI-20969873312915338: an ancestor lookup error is
  #    irrelevant when the later exact-source block is healthy.
  # The user/host here are the canonical John-Doe stand-ins, NOT this box's identity:
  # a fixture that spelled the real ones would leak them into the release bundle
  # (WI-4776 class, caught by lint:no-box-identity / lint:no-identity-literals). The
  # parser under test is pure string work, so the exact names are irrelevant to it.
  mixed_listing="jdoe@host:/home/jdoe
  2026-08-20 12:00:00 EDT <ERROR> error reading directory: entry not found

jdoe@host:/home/jdoe/macos-vm
  2026-08-20 13:00:00 EDT abc123 10 GB drwxr-xr-x files:1 dirs:1"
  exact_block=$(printf '%s\n' "$mixed_listing" | exact_source_block /home/jdoe/macos-vm)
  if printf '%s\n' "$exact_block" | grep -qF ':/home/jdoe/macos-vm' \
     && ! printf '%s\n' "$exact_block" | grep -q '<ERROR>'; then
    printf '  ok    %s\n' "exact-source parser ignores an ancestor error block"; pass=$((pass+1))
  else
    printf '  FAIL  %s\n' "exact-source parser rejected a healthy exact block after an ancestor error"; failed=$((failed+1))
  fi
  # 3b. WI-2146225 — the source-COVERAGE matcher (check 2c) must discriminate.
  # The failure it guards is ABSENCE, so a matcher that is too loose recreates the
  # exact false green it was added to kill: a PARENT source (/mnt/data/Backup)
  # must NOT satisfy a check for its child (/mnt/data/Backup/db-dumps), and an
  # indented detail row must not be mistaken for a source header. Tested as pure
  # string work against a fixture, so it needs no repo and no snapshots.
  # Mirrors check 2c's production matcher: coverage requires a COMPLETE snapshot
  # row inside the source's own block, never merely the presence of a header.
  src_covered() { # <listing> <wanted source path>
    [ "$(printf '%s\n' "$1" | awk -v want=":$2" '
      /^[^[:space:]]/ {
        inblock = (length($0) >= length(want) &&
                   substr($0, length($0) - length(want) + 1) == want)
        if (inblock) seen = 1
        next
      }
      inblock && /^[[:space:]]/ && $0 !~ /<ERROR>/ && $0 !~ /incomplete/ { complete = 1 }
      END { print (complete ? "complete" : (seen ? "registered-only" : "absent")) }')" = complete ]
  }
  cov_listing="jdoe@host:/mnt/data/Backup
  2026-09-05 12:00:00 EDT abc123 1 GB drwxr-xr-x files:1 dirs:1 :/mnt/cold-a/Backup/db-dumps
jdoe@host:/mnt/cold-a/Backup/db-dumps-other"
  cov_ok=1
  # present-as-parent-only must read as NOT covered
  src_covered "$cov_listing" /mnt/data/Backup/db-dumps && cov_ok=0
  # a path appearing only in an INDENTED detail row must read as NOT covered
  src_covered "$cov_listing" /mnt/cold-a/Backup/db-dumps && cov_ok=0
  # a longer sibling header must not satisfy the shorter path either
  src_covered "$cov_listing" /mnt/backup/db-dump && cov_ok=0
  # positive control: the parent itself IS a real header and must read as covered
  src_covered "$cov_listing" /mnt/data/Backup || cov_ok=0
  if [ "$cov_ok" = 1 ]; then
    printf '  ok    %s\n' "source-coverage matcher rejects parent/substring/detail-row matches"; pass=$((pass+1))
  else
    printf '  FAIL  %s\n' "source-coverage matcher accepted a non-source as coverage"; failed=$((failed+1))
  fi

  # 3c. WI-2146225 — A SOURCE HEADER IS NOT COVERAGE. The first version of check
  # 2c matched the header alone, and `kopia snapshot list --all` prints a header
  # for a source whose only snapshots are incomplete (it hides those rows unless
  # --incomplete is passed). Since the backup guard aborts sweeps under pressure
  # and every abort leaves exactly that residue, a header-only check goes green
  # the moment the first snapshot STARTS and stays green while every one of them
  # is killed. Observed live on 2026-09-05 against two `incomplete:canceled`
  # snapshots of 2 KB. This is the case that must never regress.
  inc_ok=1
  # header alone, zero rows — what --all shows for an incomplete-only source
  src_covered "jdoe@host:/mnt/cold-a/Backup/db-dumps" /mnt/cold-a/Backup/db-dumps && inc_ok=0
  # an explicitly incomplete row must not count either
  src_covered "jdoe@host:/mnt/cold-a/Backup/db-dumps
  2026-09-05 13:15:24 EDT kbeef1 incomplete:canceled 2 KB drwxrwxr-x files:3 dirs:4 (incomplete)" \
    /mnt/cold-a/Backup/db-dumps && inc_ok=0
  # an <ERROR> row is not a snapshot either
  src_covered "jdoe@host:/mnt/cold-a/Backup/db-dumps
  2026-09-05 13:15:24 EDT <ERROR> error reading directory: entry not found" \
    /mnt/cold-a/Backup/db-dumps && inc_ok=0
  # positive control: one real completed row IS coverage — without this the three
  # assertions above would all pass against a matcher that never returns true.
  src_covered "jdoe@host:/mnt/cold-a/Backup/db-dumps
  2026-09-05 13:15:24 EDT abc123 130 GB drwxrwxr-x files:743 dirs:12 (latest-1)" \
    /mnt/cold-a/Backup/db-dumps || inc_ok=0
  if [ "$inc_ok" = 1 ]; then
    printf '  ok    %s\n' "coverage requires a COMPLETE snapshot, not just a source header"; pass=$((pass+1))
  else
    printf '  FAIL  %s\n' "coverage matcher accepted a header/incomplete/error row as coverage"; failed=$((failed+1))
  fi

  # 4. Production defaults against the real, healthy backup: green and silent.
  #    If this reds, backups are genuinely broken — read the log; do NOT "fix" the test.
  check "production defaults on a healthy backup: green, no page" 0 no

  # 5-7. EI-12010 ALERT DEDUP/BACKOFF — a persistent state dir shared across back-to-back
  # invocations (unlike `check()` above, which isolates a FRESH dir every call on purpose).
  # BACKUP_ALERT_FORCE=1 is used to pass the test-vs-prod ALARM_SUPPRESSED gate on every
  # call here (per its own self-test above) — proving dedup is a genuinely SEPARATE gate,
  # not just re-testing suppression under a different name.
  dedup_state="$tmp/dedup-state"; rm -rf "$dedup_state"; mkdir -p "$dedup_state"
  run_dedup() { # sets $dedup_paged=yes|no
    rm -f "$tmp/paged"
    env BACKUP_ALERT_CMD="$stub" HEALTHCHECK_STATE_DIR="$dedup_state" \
        MAX_DUMP_AGE_S=1 ALERT_REFILE_S=3600 BACKUP_ALERT_FORCE=1 \
        bash "$self" >/dev/null 2>&1
    dedup_paged=no; [ -s "$tmp/paged" ] && dedup_paged=yes
  }
  # 5. FIRST real failure of a fresh condition pages.
  run_dedup; first_paged="$dedup_paged"
  if [ "$first_paged" = yes ]; then
    printf '  ok    %s (paged=%s)\n' "first real failure (fresh state) pages" "$first_paged"; pass=$((pass+1))
  else
    printf '  FAIL  %s — wanted paged=yes, got paged=%s\n' "first real failure (fresh state) pages" "$first_paged"; failed=$((failed+1))
  fi
  # 6. THE BUG THIS FIXES: a SECOND back-to-back real failure of the SAME still-red
  #    condition, inside the refile window, must NOT re-page — this is the exact
  #    "7 broadcasts in 30 minutes" spam EI-12010 reports.
  run_dedup; second_paged="$dedup_paged"
  if [ "$second_paged" = no ]; then
    printf '  ok    %s (paged=%s)\n' "back-to-back same-condition failure is DEDUPED within the refile window" "$second_paged"; pass=$((pass+1))
  else
    printf '  FAIL  %s — wanted paged=no, got paged=%s\n' "back-to-back same-condition failure is deduped" "$second_paged"; failed=$((failed+1))
  fi
  # 7. NOT A PERMANENT MUTE: a marker OLDER than the refile window pages again.
  echo "$(( $(date +%s) - 7200 ))" > "$dedup_state/last-alert"   # 2h-old marker, 1h window
  run_dedup; third_paged="$dedup_paged"
  if [ "$third_paged" = yes ]; then
    printf '  ok    %s (paged=%s)\n' "a marker OLDER than the refile window pages again (not a permanent mute)" "$third_paged"; pass=$((pass+1))
  else
    printf '  FAIL  %s — wanted paged=yes, got paged=%s\n' "expired-window re-page" "$third_paged"; failed=$((failed+1))
  fi

  printf '  ---- %d passed, %d failed\n' "$pass" "$failed"
  [ "$failed" -eq 0 ] || exit 1
  exit 0
fi

# ── 0. DETECT (page later) A KOPIA PROCESS THAT OUTLIVED ITS STOPPED UNIT ─────
# Rationale in section 3. Detected FIRST because every check below may fail() and
# exit; fail() then carries LEFTOVER_NOTE on its page (WI-6554700010011924).
UNIT_CGROUP_ROOT="${KOPIA_UNIT_CGROUP_ROOT:-/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service}"
SYSTEMCTL_BIN="${KOPIA_HEALTHCHECK_SYSTEMCTL:-/usr/bin/systemctl}"
unit_stopped() { # true when the unit's SubState means "no process should be running"
  case "$("$SYSTEMCTL_BIN" --user show -p SubState --value "$1" 2>/dev/null)" in
    dead|failed|auto-restart|auto-restart-queued) return 0 ;;
    *) return 1 ;;
  esac
}
unit_procs() { tr '\n' ' ' < "$1/cgroup.procs" 2>/dev/null | sed 's/ *$//'; }
leftover=""
if [ -d "$UNIT_CGROUP_ROOT" ]; then
  for unit in kopia-home-snapshot.service kopia-snapshots.service; do
    cg=$(find "$UNIT_CGROUP_ROOT" -maxdepth 3 -type d -name "$unit" -print -quit 2>/dev/null || true)
    [ -n "$cg" ] || continue
    [ -n "$(unit_procs "$cg")" ] || continue   # empty cgroup: no systemctl round trip
    unit_stopped "$unit" || continue
    procs=$(unit_procs "$cg")
    [ -n "$procs" ] && unit_stopped "$unit" || continue
    leftover="${leftover:+$leftover; }$unit is stopped but its cgroup still holds pid(s) $procs"
  done
fi
LEFTOVER_NOTE=""
[ -z "$leftover" ] || LEFTOVER_NOTE="ALSO: Kopia process(es) outlived their stopped unit: $leftover (WI-6554700010011924)."

# ── 1. THE DUMP ITSELF — the check whose absence hid a 30-day outage ─────────
newest=0

# db-backup.sh: STATUS.json records the last VERIFIED-good run.
if [ -f "$STATUS" ]; then
  s=$(sed -n 's/.*"lastSuccessEpoch": *\([0-9]*\).*/\1/p' "$STATUS" | head -1)
  [ -n "${s:-}" ] && [ "$s" -gt "$newest" ] && newest="$s"
fi
# Legacy fallback: the old pre-snapshot.sh pg_dumpall artifact. Its production STOPPED at
# the EI-10733 convergence (db-backup.sh replaced it), so this only matters on a box that
# still runs the old path — MAX() means a frozen pg-5432.sql.gz never masks a fresh STATUS.json.
if [ -f "$DUMP/pg-5432.sql.gz" ]; then
  m=$(stat -c %Y "$DUMP/pg-5432.sql.gz" 2>/dev/null || echo 0)
  [ "$m" -gt "$newest" ] && newest="$m"
fi

[ "$newest" -eq 0 ] && fail "no Postgres dump has EVER succeeded (no STATUS.json, no pg-5432.sql.gz)"

age=$(( now - newest ))
if [ "$age" -gt "$MAX_DUMP_AGE_S" ]; then
  fail "Postgres dump is STALE: $(dur "$age") old (limit $(dur "$MAX_DUMP_AGE_S")). The backup is not succeeding — this is EI-10733, which hid for 30 days behind a green snapshot check."
fi

# A dump that exists but cannot be restored is not a backup. Cheap TOC read.
# (This loop covers pg/oddsmith/ too, so the embedded DB's archive validity is
# already asserted here — the block below is about its FRESHNESS.)
for d in "$DUMP"/pg/*/; do
  [ -d "$d" ] || continue
  case "$(basename "$d")" in *.tmp|*.prev) continue ;; esac
  pg_restore -l "$d" >/dev/null 2>&1 \
    || fail "dump $(basename "$d") exists but is NOT a readable archive (pg_restore -l failed)"
done

# ── 1b. THE ODDSMITH EMBEDDED PG (5544) — asserted INDEPENDENTLY (WI-39502) ──
# Separate from the cluster check above because it is a separate Postgres server
# with a separate failure mode: db-backup.sh's oddsmith leg SKIPS (does not fail
# the run) when the sidecar is down, precisely so a restartable service cannot
# redden a healthy papercusp dump. That deliberate softness needs its own hard
# floor, or "skipped" quietly becomes "never dumped" — which is exactly the state
# this box was in on 2026-08-15 when the database was destroyed unrecoverably.
#
# Gate on the DISCOVERY FILE, not on the dump: if ~/.oddsmith/embedded-pg.json is
# absent, oddsmith has never run here and there is nothing to be stale about. If it
# is present, this box HAS an oddsmith database and it must be getting dumped.
ODDSMITH_DISCOVERY="${ODDSMITH_DISCOVERY:-$HOME/.oddsmith/embedded-pg.json}"
if [ -f "$ODDSMITH_DISCOVERY" ] && [ -f "$STATUS" ]; then
  odds_last=$(sed -n 's/.*"oddsmithLastSuccessEpoch": *\([0-9]*\).*/\1/p' "$STATUS" | head -1)
  odds_note=$(sed -n 's/.*"oddsmithNote": *"\([^"]*\)".*/\1/p' "$STATUS" | head -1)
  [ -n "${odds_last:-}" ] || odds_last=0
  if [ "$odds_last" -eq 0 ]; then
    fail "the oddsmith embedded PG (5544) has NEVER been dumped successfully, yet $ODDSMITH_DISCOVERY exists — the db-backup.sh oddsmith leg is not working${odds_note:+ (last note: $odds_note)}. This is the WI-39502 condition: on 2026-08-15 that database was destroyed with no dump in existence."
  else
    odds_age=$(( now - odds_last ))
    if [ "$odds_age" -gt "$MAX_ODDSMITH_DUMP_AGE_S" ]; then
      fail "oddsmith embedded-PG dump is STALE: $(dur "$odds_age") old (limit $(dur "$MAX_ODDSMITH_DUMP_AGE_S"))${odds_note:+ — last note: $odds_note}. Either the sidecar has been down that long or its backup leg is broken; either way that DB is accumulating unbacked-up state."
    fi
  fi
fi

# ── 2. SNAPSHOT RECENCY — secondary; it is what gets the dumps OFF this box ──
# `-n 1`, NOT `--max-results-per-source` — that flag does not exist in this kopia
# build, so the old command errored out on EVERY run, LATEST was always empty, and
# the healthcheck reported "no snapshots found at all" and exited 1 every 15 min
# since the day it was written. A check that always fails is a check everyone
# learns to ignore — which is why nobody believed it when the backup ACTUALLY died
# (EI-10733). Verified against `kopia snapshot list --help` on this host.
LATEST=$(kopia_as_root "$SUDO_BIN" "$KOPIA_BIN" snapshot list --all -n 1 2>/dev/null \
  | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' \
  | sort -r | head -1)
[ -z "$LATEST" ] && fail "no kopia snapshots found at all"
snap_age=$(( now - $(date -d "$LATEST" +%s) ))
[ "$snap_age" -gt "$MAX_SNAP_AGE_S" ] \
  && fail "last kopia snapshot $(dur "$snap_age") ago ($LATEST) — dumps are not leaving this machine"

# ── 2c. THE DUMP DIRECTORY MUST ACTUALLY BE A KOPIA SOURCE (WI-2146225) ──────
# THE DETECTOR WHOSE ABSENCE HID A SECOND SILENT OUTAGE. On 2026-09-05 the
# Postgres dumps had ZERO offsite coverage: WI-2145150 relocated them to
# /mnt/backup/db-dumps (because /mnt/data hit 97%) and kopia's source list still
# named /mnt/data/Backup/db-dumps. snapshot-all.sh discovers sources by asking
# kopia which ones ALREADY HAVE a snapshot, so the new directory could never
# enter the sweep on its own — a self-perpetuating blind spot with no time bound.
#
# EVERY EXISTING CHECK IN THIS FILE STAYED GREEN THROUGH IT, and that is the
# point of adding this one rather than tightening an existing bar:
#   * check 1 asserts the dump is fresh and restorable — it reads LOCAL files and
#     is true whether or not the dump ever leaves this machine.
#   * check 2 takes the newest snapshot across ALL sources, so 16 healthy
#     sources kept it green while this one was absent entirely.
#   * check 2b covers $HOME specifically, not the dump directory.
# The dump can therefore be perfect, hourly, and validated, and simultaneously
# not backed up anywhere — which is precisely the EI-10733 shape this file
# exists to end, one layer further out.
#
# ABSENCE is the condition, so it must be asserted directly. Exact suffix match
# on the unindented header line, not a substring: a parent source would
# otherwise satisfy a check for its child and re-create the same false green.
#
# ⚠ A SOURCE HEADER IS NOT COVERAGE (WI-2146225, 2026-09-05 — the first version
# of this very check had this bug). `kopia snapshot list --all` prints the
# source header for a source whose ONLY snapshots are incomplete, and hides the
# incomplete rows themselves unless --incomplete is passed. So a header-only
# match reports COVERED off a source with nothing restorable in it. Observed
# directly: three bootstrap attempts left
#   <user>@<host>:/mnt/backup/db-dumps        <- header, no rows
# and `--incomplete` revealed two `incomplete:canceled` snapshots of 2 KB.
# A header-matching check called that COVERED.
#
# That is not a cosmetic edge case here, it is the LIKELY steady state: the
# backup guard aborts sweeps under pressure (46 of 51 hot cycles killed
# mid-run over the 48h to 2026-09-05), and every abort leaves exactly this
# residue. A header-only check would therefore go green the moment the FIRST
# snapshot STARTED and stay green forever while every one of them was killed —
# the same false green this leg exists to kill, resurrected one layer in.
#
# Assert the thing itself: at least one COMPLETE snapshot row inside this
# source's own block. Rows are indented; error rows carry <ERROR>; incomplete
# rows carry `incomplete`. Registered-but-never-completed is reported
# SEPARATELY from never-registered because they have different repairs — the
# first is a sweep that cannot finish, the second is a discovery hole.
COV_LISTING=$(kopia_as_root "$SUDO_BIN" "$KOPIA_BIN" snapshot list --all 2>/dev/null || true)
cov_state=$(printf '%s\n' "$COV_LISTING" | awk -v want=":$DUMP" '
    /^[^[:space:]]/ {
      inblock = (length($0) >= length(want) &&
                 substr($0, length($0) - length(want) + 1) == want)
      if (inblock) seen = 1
      next
    }
    inblock && /^[[:space:]]/ && $0 !~ /<ERROR>/ && $0 !~ /incomplete/ { complete = 1 }
    END { print (complete ? "complete" : (seen ? "registered-only" : "absent")) }')
case "$cov_state" in
  complete) : ;;
  registered-only)
    fail "the Postgres dump directory $DUMP is a kopia source but has NO COMPLETE SNAPSHOT — every attempt so far was left incomplete (run \`kopia snapshot list --incomplete\` on it to see them). The dumps are NOT restorable from the repo. This is the sweep being aborted mid-run, not a discovery hole: check the backup guard's kill reasons in \`journalctl --user -u kopia-snapshots.service\`."
    ;;
  *)
    fail "the Postgres dump directory $DUMP is NOT a kopia source — it has never been snapshotted, so the dumps are NOT leaving this machine. Local dumps can be fresh and restorable while this is true (checks 1/2/2b all stay green), which is how this hid. snapshot-all.sh now force-includes it via REQUIRED_SOURCES; if this is still failing, that union is not reaching kopia."
    ;;
esac

# ── 2d. PER-SOURCE RECENCY: the Postgres dump source ─────────────────────────
# Check 2's newest snapshot can belong to any source. A busy unrelated source can
# therefore keep that aggregate green while this exact source ages indefinitely.
# Check 2c proves a COMPLETE dump-source snapshot exists; it does not prove that
# snapshot is recent. Reuse the same one-hour cadence limit, but measure only rows
# in the exact dump-source block so another source cannot mask it.
dump_exact_listing=$(printf '%s\n' "$COV_LISTING" | exact_source_block "$DUMP")
dump_last=$(printf '%s\n' "$dump_exact_listing" \
  | awk '/<ERROR>|incomplete/ { next } { print }' \
  | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' \
  | sort -r | head -1)
if [ -z "$dump_last" ]; then
  fail "the Postgres dump directory $DUMP has no parseable COMPLETE snapshot timestamp — its Kopia freshness cannot be established"
fi
dump_snap_age=$(( now - $(date -d "$dump_last" +%s) ))
[ "$dump_snap_age" -gt "$MAX_SNAP_AGE_S" ] \
  && fail "Postgres dump source snapshot is STALE: $(dur "$dump_snap_age") old ($dump_last, limit $(dur "$MAX_SNAP_AGE_S")) — a fresh snapshot from another source cannot establish that $DUMP is current"

# ── 2b. PER-SOURCE RECENCY: the DAILY curated home source ────────────────────
# Check 2 above takes the newest snapshot across ALL sources (`--all -n 1 | sort -r |
# head -1`), so the 30-minute hot sweep keeps it green no matter what happens to any
# INDIVIDUAL source. That is the right shape for "are dumps leaving this box", but it is
# structurally BLIND to one source dying: $HOME is snapshotted DAILY by
# kopia-home-snapshot.timer, and if that unit broke, check 2 would stay green forever
# while $HOME silently stopped being backed up. That is this file's signature failure
# (EI-10733) — a check that cannot observe the thing it is trusted to cover — so the
# daily source gets its own bar rather than riding on the aggregate.
#
# This depends on `kopia snapshot list <path>` matching the source EXACTLY, not as a
# prefix. VERIFIED 2026-08-16: it returned NOTHING for $HOME while that path
# had no snapshot of its own, even though ELEVEN of its children were sources. Without
# that property this check would be permanently green off the hot sweep — i.e. exactly
# the blindness it exists to remove.
HOME_SNAP_SRC="${HOME_SNAP_SRC:-$HOME}"
home_listing=$(kopia_as_root "$SUDO_BIN" "$KOPIA_BIN" snapshot list "$HOME_SNAP_SRC" -n 1 2>/dev/null)
home_exact_listing=$(printf '%s\n' "$home_listing" | exact_source_block "$HOME_SNAP_SRC")
# Require the EXACT source header before trusting any timestamp in that listing.
# `kopia snapshot list <path>` resolves to the nearest ANCESTOR source and then browses
# <path> INSIDE it — so a path that is NOT itself a source still prints the ancestor's
# header and the ancestor's timestamp. Measured 2026-08-16:
#   $ kopia snapshot list "$HOME/definitely-not-a-source" -n 1
#   $USER@host:$HOME
#     2026-08-16 17:28:32 EDT <ERROR> error reading directory: entry not found
# A bare timestamp grep over that output returns 17:28:32 and reports GREEN for a source
# that does not exist. Anchoring on the header makes this a test of "is THIS path a source
# with a snapshot", not "does some ancestor have one" — which is the whole point of a
# PER-SOURCE check. It also rejects the <ERROR> shape above, where a timestamp is printed
# for a tree kopia could not actually read.
if [ -n "$home_exact_listing" ] \
   && ! printf '%s\n' "$home_exact_listing" | grep -q '<ERROR>'; then
  home_last=$(printf '%s\n' "$home_exact_listing" \
    | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' \
    | sort -r | head -1)
else
  home_last=""
fi
if [ -z "$home_last" ]; then
  # Distinct from "stale" on purpose, mirroring the oddsmith never-dumped branch: absence
  # and staleness have different causes and different fixes, and a single merged message
  # sends whoever reads it looking for the wrong one.
  fail "the curated home source ($HOME_SNAP_SRC) has NO snapshot at all — kopia-home-snapshot.timer has never produced one. \$HOME is not backed up."
else
  home_age=$(( now - $(date -d "$home_last" +%s) ))
  [ "$home_age" -gt "$MAX_HOME_SNAP_AGE_S" ] \
    && fail "curated home snapshot is STALE: $(dur "$home_age") old ($home_last, limit $(dur "$MAX_HOME_SNAP_AGE_S")) — kopia-home-snapshot.timer is not producing daily snapshots and \$HOME is drifting out of backup"
fi

# Owner-protected VM paths are deliberately excluded from the curated HOME
# source's .kopiaignore. Assert both their existence and their own exact Kopia
# source header so a missing VM cannot hide behind the healthy HOME ancestor.
# windows-vm dropped [owner 2026-09-16] — no longer snapshotted at all (see
# kopia-home-snapshot.sh VM_REQUESTED). Asserting its coverage here would alarm forever.
PROTECTED_VM_REQUESTS=( "$HOME/macos-vm" )
for requested in "${PROTECTED_VM_REQUESTS[@]}"; do
  if [ ! -d "$requested" ]; then
    fail "owner-protected VM path is MISSING: $requested — its loss is not protected or detectable elsewhere"
    continue
  fi
  protected_src=$(readlink -f "$requested")
  protected_listing=$(kopia_as_root "$SUDO_BIN" "$KOPIA_BIN" snapshot list "$protected_src" -n 1 2>/dev/null)
  protected_exact_listing=$(printf '%s\n' "$protected_listing" | exact_source_block "$protected_src")
  if [ -n "$protected_exact_listing" ] \
     && ! printf '%s\n' "$protected_exact_listing" | grep -q '<ERROR>'; then
    protected_last=$(printf '%s\n' "$protected_exact_listing" \
      | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' \
      | sort -r | head -1)
  else
    protected_last=""
  fi
  if [ -z "$protected_last" ]; then
    fail "owner-protected VM source ($requested -> $protected_src) has NO usable Kopia snapshot"
  else
    protected_age=$(( now - $(date -d "$protected_last" +%s) ))
    if [ "$protected_age" -gt "$MAX_HOME_SNAP_AGE_S" ]; then
      # A no-change run intentionally leaves protected_last unchanged.  Accept
      # it only when the daily VM leg wrote a recent marker for this exact
      # resolved source; an old/mismatched marker still fails closed.
      if verified_at="$(vm_verification_epoch "$VM_VERIFY_MARKER" "$protected_src")"; then
        verification_age=$(( now - verified_at ))
        if [ "$verification_age" -ge 0 ] && [ "$verification_age" -le "$MAX_HOME_SNAP_AGE_S" ]; then
          echo "[$(date -Iseconds)] OK: owner-protected VM source ($requested -> $protected_src) verified unchanged $(dur "$verification_age") ago; no new snapshot row was required" >> "$LOG"
          continue
        fi
      fi
      fail "owner-protected VM source ($requested -> $protected_src) is STALE: $(dur "$protected_age") old ($protected_last, limit $(dur "$MAX_HOME_SNAP_AGE_S")); no recent successful no-change verification was recorded"
    fi
  fi
done

# ── Dump duty cycle (WI-10004603) ────────────────────────────────────────────
# Freshness above cannot see this coming: every run still SUCCEEDS while its
# duration climbs toward the hourly timer period (measured 2026-10-01: 2822 ->
# 3397 s over four runs). Past the period the next timer start is a no-op on the
# running unit, so the dump runs back to back, holds the backup guard and host
# I/O permanently, and the state tier's recovery point slips one run at a time.
# Page at 90% of the hour, while there is still a run's worth of headroom to act.
# LAST on purpose: fail() exits, and a duty warning must never hide a staleness
# or validity failure checked above.
# Judged only on a STATUS.json that carries "periodSec": that field is written by
# the producer that HAS the cadence lever (PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC). A
# status from an older producer predates the fix, so paging on it would page about
# a condition the next run already addresses.
if [ -f "$STATUS" ] && grep -q '"periodSec"' "$STATUS" 2>/dev/null; then
  run_s=$(sed -n 's/.*"elapsedSec": *\([0-9]*\).*/\1/p' "$STATUS" | head -1)
  if [ -n "${run_s:-}" ] && [ "$run_s" -gt "$MAX_DUMP_RUN_S" ] 2>/dev/null; then
    fail "Postgres dump run is near-continuous: the last run took $(dur "$run_s") (limit $(dur "$MAX_DUMP_RUN_S")) of its hourly timer period. Once a run outlasts the hour, the next start is a no-op and the backup never rests. Read the per-tier times in db-backup.log; lever: PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC in papercusp-db-backup.sh (WI-10004603)."
  fi
fi

# ── 3. A KOPIA PROCESS THAT OUTLIVED ITS STOPPED UNIT (WI-6554700010011924) ──
# The user manager cannot kill the root-owned sudo/Kopia children of these units
# ("Failed to kill control group ... Operation not permitted"). When a stop, or its
# ExecStopPost cleanup, times out under load, the walk keeps running in the unit's
# cgroup after the unit has stopped: OUTSIDE kopia-global.lock, until the next start's
# ExecStartPre reaps it (up to RestartSec=30min later). Measured 2026-10-13 (three
# concurrent walks, WI-6554700010011790) and again 2026-10-14 04:53Z, where systemd
# logged only "Unit process ... remains running after unit stopped".
# Signal: SubState says nothing should run, yet the unit's cgroup still has processes.
# SubState is read BEFORE and AFTER the cgroup read, so a unit that starts mid-check
# is never mistaken for a leftover. cgroupfs files always report size 0, so the
# content is read, never tested with -s. Paged LAST, like the duty check, but
# detected in section 0 so an earlier failure's page still carries it.
# DETECTED in section 0 (before any check can fail() and exit), PAGED here when nothing
# else failed. When an earlier check does fail, fail() appends LEFTOVER_NOTE to that
# page instead, so a stale dump (exactly when a leaked walk is likeliest) can no longer
# silence this finding, and the staleness message still leads.
if [ -n "$leftover" ]; then
  LEFTOVER_NOTE=""   # this page IS the finding; do not append it a second time
  fail "Kopia process(es) outlived their stopped unit: $leftover. They run outside kopia-global.lock until the unit's next start reaps them (ExecStartPre --cleanup). Inspect with: sudo ps -o pid,etimes,args -p <pid>. See WI-6554700010011924."
fi

echo "[$(date -Iseconds)] OK: dump $(( age / 60 ))m old, snapshot $(( snap_age / 60 ))m old" >> "$LOG"

#!/usr/bin/env bash
# Paired replication drills for rubric acceptance-reboot-residue-service-repairs-2026-10-03,
# criteria R-001..R-003 (rubric rev20+, vetting conv-muwk6715 posts 1159689 / 1159695).
#
# A negative-control drill FAILS on a broken host too, so on its own it proves nothing. Each row
# therefore records the REAL probe and its MUTANT in the same run:
#   DISCRIMINATES            real probe passed AND the mutant failed the way it must
#   UNKNOWN-real-probe-failed the real probe did not pass, so the mutant result is not evidence
#   MUTANT-SURVIVED          the real probe passed but the mutant also passed: the probe cannot fail
# Exit 0 only when every row reads DISCRIMINATES.
#
# Never touches the live service, the model blob, packages, kernel modules or /etc/kernel: every
# mutant is a copy inside a mktemp dir (removed on exit) or a mutated ARGUMENT to a read-only query.
# Output is redacted ($HOME, user and host names) so it can be committed as evidence.
#
# Run from anywhere:  bash docs/evidence/reboot-residue-live-probes-2026-10-06/replication-drills.sh
set -u

REPO="$(cd "$(dirname "$0")/../../.." && pwd)" || exit 2
D="$(mktemp -d /tmp/replication-drills.XXXXXX)" || exit 2
chmod 755 "$D"   # so a mutant's own permissions (not the dir's) decide another user's read
trap 'rm -rf "$D"' EXIT
ME="$(id -un)"
HOST="$(hostname)"
FAILS=0

redact() { sed -e "s#${HOME}#\$HOME#g" -e "s#\b${ME}\b#<user>#g" -e "s#${HOST}#<host>#g"; }
row() { # id real_ok real_obs mutant_ok mutant_obs
  local v
  if [ "$2" != 1 ]; then v=UNKNOWN-real-probe-failed
  elif [ "$4" = 1 ]; then v=DISCRIMINATES
  else v=MUTANT-SURVIVED; fi
  [ "$v" = DISCRIMINATES ] || FAILS=$((FAILS + 1))
  printf '%s\treal: %s\tmutant: %s\t%s\n' "$1" "$3" "$5" "$v" | redact
}
b() { if "$@"; then echo 1; else echo 0; fi; }

echo "# run_at=$(date -u +%FT%TZ) kernel=$(uname -r)" | redact

# ---- R-001 AgenticMail API ----------------------------------------------------------------------
PORT="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.agenticmail/config.json')))['api']['port'])")"
REAL_HEALTH="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "127.0.0.1:${PORT}/api/agenticmail/health")"
REAL_OK="$(b test "$REAL_HEALTH" = 200)"

# (1a) a mistyped route must answer a 4xx: the server is up and routing, so the real 200 comes from
#      the mounted health route, not a catch-all. 000 (nothing answered) is not a 4xx.
MUT="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "127.0.0.1:${PORT}/api/agenticmail/healthz")"
row R-001.1a-mistyped-route "$REAL_OK" "/api/agenticmail/health=${REAL_HEALTH}" "$(b grep -qE '^4[0-9]{2}$' <<<"$MUT")" "/api/agenticmail/healthz=${MUT}"

# (1b) the real route on a port the kernel just proved free must print 000.
FREE="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
MUT="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "127.0.0.1:${FREE}/api/agenticmail/health")"
row R-001.1b-unused-port "$REAL_OK" "port ${PORT}=${REAL_HEALTH}" "$(b test "$MUT" = 000)" "free port ${FREE}=${MUT}"

# (2) entry path, copy-out: point the exec line at a file that does not exist.
entry_ok() { local e; e="$(grep -E '^exec ' "$1" | grep -oE '"[^"]+\.js"' | tr -d '"')"; [ -n "$e" ] && [ "$(wc -l <<<"$e")" = 1 ] && test -f "$e"; }
cp "$HOME/.agenticmail/bin/start-server.sh" "$D/start-server.sh"
sed -i 's#/dist/index\.js"#/dist/index-MUTANT.js"#' "$D/start-server.sh"
R="$(b entry_ok "$HOME/.agenticmail/bin/start-server.sh")"
if cmp -s "$HOME/.agenticmail/bin/start-server.sh" "$D/start-server.sh"; then M=0; MOBS="no-op mutation"
else M="$(b test "$(b entry_ok "$D/start-server.sh")" = 0)"; MOBS="entry $( [ "$M" = 1 ] && echo missing || echo present ) copy_sha=$(sha256sum "$D/start-server.sh" | cut -c1-12)"; fi
row R-001.2-entry-path "$R" "entry $( [ "$R" = 1 ] && echo present || echo MISSING )" "$M" "$MOBS"

# (3) unit state: a control unit chosen by its MEASURED state now (loaded + inactive), not by name.
CTRL=""
for u in $(systemctl --user list-units --all --type=service --state=inactive --no-legend --plain | awk '{print $1}'); do
  [ "$(systemctl --user show "$u" -p LoadState --value)" = loaded ] && { CTRL="$u"; break; }
done
REAL_STATE="$(systemctl --user show agenticmail.service -p ActiveState --value)"
if [ -n "$CTRL" ]; then CS="$(systemctl --user show "$CTRL" -p ActiveState --value)"; M="$(b test "$CS" != active)"; else CS="none-found"; M=0; fi
row R-001.3-inactive-unit "$(b test "$REAL_STATE" = active)" "agenticmail.service=${REAL_STATE}" "$M" "${CTRL:-<none>}=${CS}"

# ---- R-002 Ornith GGUF blob ---------------------------------------------------------------------
BLOB="$(systemctl --user cat llama-ornith.service | grep -oE '(-m|--model) +[^ ]+' | head -1 | awk '{print $2}')"
WANT="${BLOB##*sha256-}"
REAL_SHA="$(sha256sum "$BLOB" | cut -d' ' -f1)"
COPY="$D/sha256-${WANT}"
head -c 1048576 "$BLOB" > "$COPY"
COPY_SHA="$(sha256sum "$COPY" | cut -d' ' -f1)"
row R-002.1-digest "$(b test "$REAL_SHA" = "$WANT")" "digest $( [ "$REAL_SHA" = "$WANT" ] && echo match || echo MISMATCH )" \
  "$(b test "$COPY_SHA" != "$WANT")" "1MiB copy digest $( [ "$COPY_SHA" != "$WANT" ] && echo mismatch || echo match ) copy_sha=${COPY_SHA:0:12}"

# (2) read access for each user that reads the blob: llama-ornith's runtime user (User= of the user
#     unit, else the user manager's own user) and ollama (owner, system ollama.service). The mutant is
#     a chmod-000 copy in a world-traversable dir, so only the file mode can deny the read.
UNIT_USER="$(systemctl --user show llama-ornith.service -p User --value)"; UNIT_USER="${UNIT_USER:-$ME}"
cp "$COPY" "$D/unreadable"; chmod 000 "$D/unreadable"
for reader in "$UNIT_USER" ollama; do
  if id -u "$reader" >/dev/null 2>&1; then
    R="$(b sudo -n -u "$reader" test -r "$BLOB")"
    M="$(b test "$(b sudo -n -u "$reader" test -r "$D/unreadable")" = 0)"
  else R=0; M=0; fi
  row "R-002.2-read-as-${reader}" "$R" "real blob readable=$( [ "$R" = 1 ] && echo yes || echo NO )" "$M" "chmod-000 copy readable=$( [ "$M" = 1 ] && echo no || echo YES )"
done

# ---- R-003 VirtualBox kernel module --------------------------------------------------------------
KVER="$(uname -r)"
DP="$(dpkg-query -W -f='${db:Status-Abbrev}' virtualbox-7.2 2>/dev/null | tr -d ' ')"
DPM="$(dpkg-query -W -f='${db:Status-Abbrev}' virtualbox-7.2-mutant 2>/dev/null | tr -d ' ')"
row R-003.1-package "$(b test "$DP" = ii)" "virtualbox-7.2=${DP:-absent}" "$(b test "$DPM" != ii)" "virtualbox-7.2-mutant=${DPM:-absent}"

# (2) vermagic: the real value must be NON-EMPTY and equal uname -r before the mutant comparison counts.
VM="$(modinfo -F vermagic vboxdrv 2>/dev/null | cut -d' ' -f1)"
row R-003.2-vermagic "$(b test -n "$VM" -a "$VM" = "$KVER")" "vermagic=${VM:-<empty>}" "$(b test "$VM" != "${KVER}-mutant")" "vs ${KVER}-mutant: $( [ "$VM" != "${KVER}-mutant" ] && echo mismatch || echo match )"

# (3) lsmod: the real module must be listed; a mutated name must not be.
LR="$(lsmod | awk '$1=="vboxdrv"{print $1}')"
LM="$(lsmod | awk '$1=="vboxdrv-mutant"{print $1}')"
row R-003.3-lsmod "$(b test -n "$LR")" "vboxdrv $( [ -n "$LR" ] && echo listed || echo NOT-listed )" "$(b test -z "$LM")" "vboxdrv-mutant $( [ -z "$LM" ] && echo absent || echo listed )"

# (4) installed hook: cmp of the repo copy must exit 0; a one-line-appended copy must exit EXACTLY 1
#     (exit 2 means the installed hook is missing, which is a broken host, not discrimination).
HOOK_SRC="$REPO/apps/operator/scripts/systemd/vboxdrv-rebuild.kernel-hook"
for dir in postinst.d header_postinst.d; do
  cmp -s "$HOOK_SRC" "/etc/kernel/$dir/vboxdrv-rebuild"; RC=$?
  cp "$HOOK_SRC" "$D/hook"; echo '# mutant' >> "$D/hook"
  cmp -s "$D/hook" "/etc/kernel/$dir/vboxdrv-rebuild"; MC=$?
  row "R-003.4-hook-${dir}" "$(b test "$RC" = 0)" "cmp exit ${RC}" "$(b test "$MC" = 1)" "cmp exit ${MC} copy_sha=$(sha256sum "$D/hook" | cut -c1-12)"
done

echo "# rows_not_discriminating=${FAILS}"
[ "$FAILS" = 0 ]

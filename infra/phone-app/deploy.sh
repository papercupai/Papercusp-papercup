#!/usr/bin/env bash
# Phone app — deploy the self-hosted media plane (plan phone-app-2026-08-30, P-002, D-002).
#
# Idempotent: safe to re-run. Mints the API secret on first run, renders the
# committed templates into ~/.config/papercusp-phone/ (0600, outside the repo),
# installs the systemd --user units, starts them, and waits for health.
#
# The API secret is never printed, never logged, and never written into the tree.
#
#   deploy.sh                  deploy / converge
#   deploy.sh --hosted         require + persist a public wss:// browser URL
#   deploy.sh --render-only    validate + prepare config, no services or key minting
#   deploy.sh --preflight      check public DNS + trusted TLS, no writes or restarts
#   deploy.sh --rotate-secret  mint a fresh secret and restart both units
#   deploy.sh --status         report only, change nothing
#   deploy.sh --pin-artifacts  pin reviewed source and binary bytes, no restart
#   deploy.sh --verify-artifacts  check the pin without changing anything
#   deploy.sh --stage-rollback  preserve the verified artifact before an upgrade
#   deploy.sh --rollback-drill  restore it into a fresh private directory only
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${PHONE_CONFIG_DIR:-$HOME/.config/papercusp-phone}"
ENV_FILE="$CONF_DIR/livekit.env"
UNIT_DIR="$HOME/.config/systemd/user"
LK_BIN="${PHONE_LIVEKIT_BIN:-$HOME/.local/bin/livekit-server}"
# The TURN server is public (D-024/D-025). livekit-server refuses to relay to
# private/loopback peers only from v1.12.0, and caps relay allocations per
# participant from v1.13.6; 1.10.1 relayed to any address (WI-10006603).
LK_MIN_VERSION="1.13.6"
SIP_BIN="${PHONE_SIP_BIN:-$HOME/.local/bin/livekit-sip}"
HEALTH_URL="http://127.0.0.1:7890/"
UNITS=(papercusp-phone-livekit.service papercusp-phone-sip.service)

# The P-004 agent worker. Its tree is NOT in this repo — it is its own git repo
# under .papercusp-workspaces/<workspace>/.papercusp/apps/phone-app — so unlike
# the two media-plane units this one is rendered from a template with a real
# path. Overridable because the workspace segment is the one part of it that is
# genuinely machine-specific.
WORKER_UNIT="papercusp-phone-worker.service"
WORKER_DIR="${PHONE_WORKER_DIR:-$HOME/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app/worker}"
NODE_BIN="${PHONE_NODE_BIN:-$(command -v node || echo /usr/bin/node)}"

# The portal-facing sidecar (WI-1409555) — same out-of-repo tree as the worker,
# so same rendered-template treatment. It is what lets the Portal at :3801 start
# a call; without it the Phone surface renders but "Call assistant" cannot mint
# a room.
SIDECAR_UNIT="papercusp-phone-sidecar.service"
SIDECAR_DIR="${PHONE_SIDECAR_DIR:-$HOME/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app/apps/sidecar}"
# The portal↔sidecar shared bearer secret. Kept OUT of livekit.env on purpose:
# that file is the media credential of record and the portal must never be given
# it, but the portal DOES need this one.
PORTAL_ENV_FILE="$CONF_DIR/portal.env"
# WI-10006587: the ops-alert backup check and the backup unit both read this file.
OPS_ALERT_ENV_FILE="$CONF_DIR/ops-alert.env"
PHONE_BACKUP_ARCHIVE="${PHONE_BACKUP_ARCHIVE:-$HOME/.local/state/papercusp-phone/backups/phone-db.dump}"
PHONE_BACKUP_MAX_AGE_HOURS="${PHONE_BACKUP_MAX_AGE_HOURS:-36}"
PIN_FILE="$CONF_DIR/artifacts.sha256"
ROLLBACK_DIR="$CONF_DIR/rollback"

# Capture caller overrides BEFORE sourcing the persisted file. `source` quite
# correctly restores the last deployment, but without this snapshot it also
# erases an explicit URL supplied for THIS convergence.
REQUESTED_LIVEKIT_URL="${PHONE_LIVEKIT_URL:-}"
REQUESTED_LIVEKIT_PUBLIC_URL="${PHONE_LIVEKIT_PUBLIC_URL:-}"
MEDIA_KEYS=(PHONE_TURN_DOMAIN PHONE_TURN_CERT_FILE PHONE_TURN_KEY_FILE PHONE_TURN_TLS_PORT PHONE_EDGE_IFACE)
declare -A REQUESTED_MEDIA=()
for key in "${MEDIA_KEYS[@]}"; do
  [[ ! -v "$key" ]] || REQUESTED_MEDIA[$key]="${!key}"
done

ROTATE=0; STATUS_ONLY=0; HOSTED=0; RENDER_ONLY=0; PREFLIGHT_ONLY=0; PIN_ONLY=0; VERIFY_PIN_ONLY=0
STAGE_ROLLBACK=0; DRILL_ROLLBACK=0
for a in "$@"; do
  case "$a" in
    --rotate-secret) ROTATE=1 ;;
    --status) STATUS_ONLY=1 ;;
    --hosted) HOSTED=1 ;;
    --render-only) RENDER_ONLY=1 ;;
    --preflight) PREFLIGHT_ONLY=1 ;;
    --pin-artifacts) PIN_ONLY=1 ;;
    --verify-artifacts) VERIFY_PIN_ONLY=1 ;;
    --stage-rollback) STAGE_ROLLBACK=1 ;;
    --rollback-drill) DRILL_ROLLBACK=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# Refuse a livekit-server older than the TURN policy needs. Installing a newer
# binary by hand is not enough on its own: a stale one must not converge.
require_livekit_version() {
  local bin="$1" min="$2" have
  have="$("$bin" --version 2>&1 | head -1 | awk '{print $NF}')" || true
  [[ "$have" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "cannot read a livekit-server version from $bin (got '$have')"
  [[ "$(printf '%s\n%s\n' "$min" "$have" | sort -V | head -1)" == "$min" ]] \
    || die "livekit-server $have is older than $min: its TURN relays to private and loopback peers (WI-10006603)"
  say "livekit-server $have"
}

# Rewrites ONE key's line in an env file (default livekit.env), keeping every
# other line. A missing file is created private first.
upsert_env_var() {
  local key="$1" value="$2" file="${3:-$ENV_FILE}" tmp
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid env key: $key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$key contains a newline"
  [[ -f "$file" ]] || ( umask 077; : > "$file" )
  tmp="$(mktemp "$CONF_DIR/.$(basename "$file").XXXXXX")"
  awk -v key="$key" '$0 !~ ("^" key "=") { print }' "$file" > "$tmp"
  # Persist shell-safe values; cert paths may contain spaces or shell punctuation.
  printf '%s=%q\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# WI-10006587: phone-ops-alert raises backup:config-missing on every run unless
# PHONE_BACKUP_ARCHIVE (absolute) and PHONE_BACKUP_MAX_AGE_HOURS (1..168) are set.
# The backup unit writes that same archive. Only these two lines are rewritten,
# so any other ops-alert setting in the file survives a redeploy.
write_ops_alert_env() {
  local archive="$1" max_age="$2"
  [[ "$archive" == /* ]] || die "PHONE_BACKUP_ARCHIVE must be an absolute path (got '$archive')"
  [[ "$max_age" =~ ^[0-9]+$ ]] && (( max_age >= 1 && max_age <= 168 )) \
    || die "PHONE_BACKUP_MAX_AGE_HOURS must be 1..168 (got '$max_age')"
  upsert_env_var PHONE_BACKUP_ARCHIVE "$archive" "$OPS_ALERT_ENV_FILE"
  upsert_env_var PHONE_BACKUP_MAX_AGE_HOURS "$max_age" "$OPS_ALERT_ENV_FILE"
  chmod 600 "$OPS_ALERT_ENV_FILE"
}

# Mint or rotate the LiveKit API key pair by rewriting ONLY its two lines.
# livekit.env is shared: it also carries the worker's vendor credentials
# (DEEPGRAM_API_KEY, GOOGLE_*, ELEVEN_API_KEY from sync-worker-secrets.ts),
# the public-edge coordinates and the carrier key (TELNYX_API_KEY, D-020).
# Truncating it on --rotate-secret silently disabled the worker's STT
# (WI-10006571), so the rest of the file must survive a rotation.
write_livekit_credentials() {
  local key="$1" secret="$2"
  [[ -n "$key" && -n "$secret" ]] || die "write_livekit_credentials needs a key and a secret"
  [[ -f "$ENV_FILE" ]] || ( umask 077; : > "$ENV_FILE" )
  upsert_env_var PHONE_LIVEKIT_API_KEY "$key"
  upsert_env_var PHONE_LIVEKIT_API_SECRET "$secret"
  chmod 600 "$ENV_FILE"
}

# The worker→sidecar ingest secret (header x-phone-worker-secret). The voice
# worker and the sidecar both load livekit.env, so this ONE line arms both
# ends. Without it the worker logs "sidecar reporting DISABLED" and the
# sidecar boots with workerIngest disabled: no call context, transcripts,
# consent notices, voicemail or summaries are recorded (WI-10006645).
# Checked against the FILE, not the environment, so a value exported in the
# caller's shell can never stand in for a persisted one. Minted once; rotated
# only by --rotate-secret, whose Start step restarts both units together.
ensure_worker_secret() {
  [[ -f "$ENV_FILE" ]] || ( umask 077; : > "$ENV_FILE" )
  if [[ $ROTATE == 1 ]] || ! grep -qE '^PHONE_WORKER_SECRET=.+' "$ENV_FILE"; then
    upsert_env_var PHONE_WORKER_SECRET "$(openssl rand -hex 32)"
    say "minted PHONE_WORKER_SECRET into $ENV_FILE (worker↔sidecar ingest; not printed)"
  else
    say "reusing PHONE_WORKER_SECRET in $ENV_FILE"
  fi
}

report_status() {
  # A green LiveKit HTTP endpoint alone is NOT Phone readiness: SIP, the
  # worker and the portal sidecar may independently be down. This path is
  # read-only, fails closed, and deliberately does not imply public calling.
  [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }
  export PHONE_LIVEKIT_URL="${PHONE_LIVEKIT_URL:-ws://127.0.0.1:7890}"
  export PHONE_SIDECAR_URL="${PHONE_SIDECAR_URL:-ws://127.0.0.1:8793}"
  "$NODE_BIN" "$HERE/media-config.mjs" local-readiness
}

# Units restart together, and the sidecar's HTTP endpoint answers a few seconds
# after systemd reports the unit active, so one read straight after a restart
# can report a transient not-ready. Both 2026-10-06 hosted redeploys exited 1 on
# sidecar-http while every component was ready seconds later. Retry quietly
# within a bound, then report once; a component that never converges still fails.
await_readiness() {
  local attempts="${1:-30}" i
  for ((i = 1; i < attempts; i++)); do
    report_status >/dev/null 2>&1 && break
    sleep "${PHONE_READINESS_RETRY_SEC:-1}"
  done
  report_status
}

# Pin the maintained Phone git tree and the exact executable/config bytes that
# deploy.sh will use. Credentials and rendered configs are deliberately excluded.
# The phone tree is a separate repo; a clean commit pins its complete tracked
# source, while the sha256 lines pin host binaries and this deployment source.
phone_source_revision() {
  [[ -d "$WORKER_DIR" && -d "$SIDECAR_DIR" ]] || die "Phone worker and sidecar source are required for an artifact pin"
  local worker_root sidecar_root dirty revision
  worker_root="$(git -C "$WORKER_DIR" rev-parse --show-toplevel)" || die "Phone worker is not in a git tree"
  sidecar_root="$(git -C "$SIDECAR_DIR" rev-parse --show-toplevel)" || die "Phone sidecar is not in a git tree"
  [[ "$worker_root" == "$sidecar_root" ]] || die "Phone worker and sidecar must share one source revision"
  # Peer test receipts and evidence may be in progress in the shared Phone
  # checkout. They are not loaded by these production entrypoints; all other
  # tracked/untracked source changes still refuse the pin.
  dirty="$(git -C "$worker_root" status --porcelain --untracked-files=all -- . \
    ':(exclude)docs/evidence/**' \
    ':(exclude,glob)**/*.test.ts' \
    ':(exclude,glob)**/*.integration.test.ts' \
    ':(exclude,glob)**/*.e2e.test.ts')" || die "cannot inspect Phone source changes"
  [[ -z "$dirty" ]] || die "Phone runtime source is not clean; pin a committed candidate"
  revision="$(git -C "$worker_root" rev-parse HEAD)" || die "cannot resolve Phone source revision"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "invalid Phone source revision"
  printf '%s\n' "$revision"
}

artifact_files_paths() {
  ARTIFACT_FILES=(
    "$HERE/deploy.sh" "$HERE/media-config.mjs" "$HERE/verify-media-plane.sh"
    "$HERE/phone-db-backup.mjs" "$HERE/report-runtime-vintage.mjs"
    "$HERE/livekit-server.yaml.tmpl" "$HERE/livekit-sip.yaml.tmpl"
    "$HERE/systemd/papercusp-phone-livekit.service"
    "$HERE/systemd/papercusp-phone-sip.service"
    "$HERE/systemd/$WORKER_UNIT.tmpl" "$HERE/systemd/$SIDECAR_UNIT.tmpl"
    "$HERE/phone-ops-alert.mjs"
    "$HERE/systemd/papercusp-phone-ops-alert.service.tmpl"
    "$HERE/systemd/papercusp-phone-ops-alert.timer"
    "$HERE/systemd/papercusp-phone-backup.service.tmpl"
    "$HERE/systemd/papercusp-phone-backup.timer"
    "$LK_BIN" "$SIP_BIN" "$NODE_BIN"
  )
}

artifact_files() {
  artifact_files_paths
  local file
  for file in "${ARTIFACT_FILES[@]}"; do
    [[ -f "$file" ]] || die "artifact missing: $file"
  done
}

verify_artifacts() {
  local manifest="${1:-$PIN_FILE}" marker revision actual pinned current
  [[ -f "$manifest" ]] || die "artifact pin missing: $manifest; prepare it with --pin-artifacts"
  read -r marker revision < "$manifest" || die "invalid artifact pin"
  [[ "$marker" == PHONE_ARTIFACT_PIN_V1 && "$revision" =~ ^[0-9a-f]{40}$ ]] || die "invalid artifact pin header"
  actual="$(phone_source_revision)" || exit 1
  [[ "$actual" == "$revision" ]] || die "Phone source revision differs from artifact pin"
  artifact_files
  pinned="$(tail -n +2 "$manifest")" || die "cannot read artifact pin"
  current="$(sha256sum -- "${ARTIFACT_FILES[@]}")" || die "cannot hash Phone artifacts"
  # Exact ordered manifest equality also refuses a truncated/duplicate manifest;
  # sha256sum -c alone would accept a file that simply omitted an artifact.
  [[ "$current" == "$pinned" ]] || die "artifact bytes differ from pin"
}

pin_artifacts() {
  local revision tmp
  revision="$(phone_source_revision)" || exit 1
  artifact_files
  mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
  tmp="$(mktemp "$CONF_DIR/.artifacts.sha256.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  if ! { printf 'PHONE_ARTIFACT_PIN_V1 %s\n' "$revision"; sha256sum -- "${ARTIFACT_FILES[@]}"; } > "$tmp"; then
    rm -f "$tmp"; die "could not hash Phone artifacts"
  fi
  chmod 600 "$tmp"
  verify_artifacts "$tmp"
  mv -f "$tmp" "$PIN_FILE"
  trap - EXIT
  say "pinned Phone source revision $revision and ${#ARTIFACT_FILES[@]} artifact files in $PIN_FILE"
}

# A rollback point contains the *old* reviewed bytes, including the Phone git
# source at the pinned revision. Keep it outside the repo and private; never
# rewrite it while preparing a new candidate. No running service is touched.
stage_rollback() {
  verify_artifacts
  [[ ! -e "$ROLLBACK_DIR" && ! -L "$ROLLBACK_DIR" ]] || die "rollback point already exists; refusing to overwrite it"
  mkdir -m 700 "$ROLLBACK_DIR" || die "cannot create a private rollback point"
  trap 'rm -rf -- "$ROLLBACK_DIR"' EXIT
  mkdir -m 700 "$ROLLBACK_DIR/files"
  cp -- "$PIN_FILE" "$ROLLBACK_DIR/pin"
  chmod 600 "$ROLLBACK_DIR/pin"
  local marker revision i=0 file
  read -r marker revision < "$ROLLBACK_DIR/pin"
  git -C "$WORKER_DIR" archive --format=tar "$revision" > "$ROLLBACK_DIR/source.tar"
  [[ -s "$ROLLBACK_DIR/source.tar" ]] || die "Phone source archive is empty"
  chmod 600 "$ROLLBACK_DIR/source.tar"
  for file in "${ARTIFACT_FILES[@]}"; do
    cp -p -- "$file" "$ROLLBACK_DIR/files/$i"
    ((i+=1))
  done
  (cd "$ROLLBACK_DIR"; sha256sum pin source.tar files/* > hashes.sha256)
  chmod 600 "$ROLLBACK_DIR/hashes.sha256"
  printf 'PHONE_ROLLBACK_V1\n' > "$ROLLBACK_DIR/.ready"
  chmod 600 "$ROLLBACK_DIR/.ready"
  trap - EXIT
  say "saved private rollback point for Phone source $revision; no running service changed"
}

rollback_drill() {
  [[ -f "$ROLLBACK_DIR/.ready" && "$(cat "$ROLLBACK_DIR/.ready")" == PHONE_ROLLBACK_V1 ]] \
    || die "complete rollback point missing"
  [[ "$(stat -c %a "$ROLLBACK_DIR")" == 700 ]] || die "rollback point must be private (0700)"
  local marker revision expected actual i=0 file scratch
  read -r marker revision < "$ROLLBACK_DIR/pin" || die "invalid rollback pin"
  [[ "$marker" == PHONE_ARTIFACT_PIN_V1 && "$revision" =~ ^[0-9a-f]{40}$ ]] \
    || die "invalid rollback source revision"
  # The manifest must contain every artifact, in exactly the pinned order.
  # Do not require current candidate binaries/source to match the old revision.
  artifact_files_paths
  [[ "$(wc -l < "$ROLLBACK_DIR/pin")" -eq "$((${#ARTIFACT_FILES[@]} + 1))" ]] \
    || die "rollback pin has missing or extra artifacts"
  for file in "${ARTIFACT_FILES[@]}"; do
    expected="$(sed -n "$((i + 2))p" "$ROLLBACK_DIR/pin")"
    actual="$(sha256sum -- "$ROLLBACK_DIR/files/$i")"
    [[ "$expected" == "${actual:0:64}  $file" ]] || die "rollback artifact does not match its pin"
    ((i+=1))
  done
  # Compare the complete ordered receipt, not `sha256sum -c`: a truncated
  # receipt would otherwise pass while omitting the source archive.
  [[ "$(cat "$ROLLBACK_DIR/hashes.sha256")" == \
     "$(cd "$ROLLBACK_DIR"; sha256sum pin source.tar files/*)" ]] \
    || die "rollback point digest mismatch"
  scratch="$(mktemp -d "$CONF_DIR/.rollback-drill.XXXXXX")"
  trap 'rm -rf -- "$scratch"' EXIT
  mkdir -m 700 "$scratch/source" "$scratch/files"
  tar -xf "$ROLLBACK_DIR/source.tar" -C "$scratch/source"
  [[ -d "$scratch/source/worker" && -d "$scratch/source/apps/sidecar" ]] \
    || die "restored Phone source lacks worker or sidecar"
  for ((i=0; i<${#ARTIFACT_FILES[@]}; i++)); do
    cp -p -- "$ROLLBACK_DIR/files/$i" "$scratch/files/$i"
    [[ "$(sha256sum "$scratch/files/$i" | cut -c1-64)" == "$(sha256sum "$ROLLBACK_DIR/files/$i" | cut -c1-64)" ]] \
      || die "isolated artifact restore differs from rollback point"
  done
  rm -rf -- "$scratch"
  trap - EXIT
  say "isolated Phone source and ${#ARTIFACT_FILES[@]} artifacts restored from $revision; no service switched or public recovery asserted"
}

# Sourced (by tests) ⇒ the definitions above only; no action below runs.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

if [[ $STATUS_ONLY == 1 ]]; then report_status; exit 0; fi
if [[ $STAGE_ROLLBACK == 1 || $DRILL_ROLLBACK == 1 ]]; then
  [[ $((STAGE_ROLLBACK + DRILL_ROLLBACK + ROTATE + RENDER_ONLY + PREFLIGHT_ONLY + STATUS_ONLY + HOSTED + PIN_ONLY + VERIFY_PIN_ONLY)) == 1 ]] \
    || die "rollback actions cannot be combined"
  if [[ $STAGE_ROLLBACK == 1 ]]; then stage_rollback; else rollback_drill; fi
  exit 0
fi
if [[ $PIN_ONLY == 1 || $VERIFY_PIN_ONLY == 1 ]]; then
  [[ $ROTATE == 0 && $RENDER_ONLY == 0 && $PREFLIGHT_ONLY == 0 && $STATUS_ONLY == 0 && $HOSTED == 0 && $PIN_ONLY != $VERIFY_PIN_ONLY ]] || die "artifact pin actions cannot be combined"
  if [[ $PIN_ONLY == 1 ]]; then pin_artifacts; else verify_artifacts; say "Phone artifacts match pin"; fi
  exit 0
fi
if [[ $PREFLIGHT_ONLY == 1 ]]; then
  [[ $ROTATE == 0 && $RENDER_ONLY == 0 ]] || die "preflight cannot render or rotate credentials"
  if [[ -f "$ENV_FILE" ]]; then
    set -a; source "$ENV_FILE"; set +a
  fi
  PHONE_LIVEKIT_PUBLIC_URL="${REQUESTED_LIVEKIT_PUBLIC_URL:-${PHONE_LIVEKIT_PUBLIC_URL:-}}"
  for key in "${MEDIA_KEYS[@]}"; do
    [[ ! -v REQUESTED_MEDIA[$key] ]] || printf -v "$key" '%s' "${REQUESTED_MEDIA[$key]}"
    export "$key"
  done
  export PHONE_LIVEKIT_PUBLIC_URL
  "$NODE_BIN" "$HERE/media-config.mjs" preflight
  exit $?
fi
if [[ $RENDER_ONLY == 1 ]]; then
  [[ $ROTATE == 0 ]] || die "preparation/preflight cannot rotate credentials"
  [[ -f "$ENV_FILE" ]] || die "preparation/preflight requires an existing external livekit.env"
fi

# A live convergence (including secret rotation) is admitted only for the
# reviewed Phone source and exact host binaries/config source pinned above.
if [[ $RENDER_ONLY == 0 ]]; then verify_artifacts; fi

# ---------------------------------------------------------------- preflight
if [[ $RENDER_ONLY == 0 ]]; then
step "Preflight"
[[ -x "$LK_BIN" ]] || die "livekit-server not found at $LK_BIN"
require_livekit_version "$LK_BIN" "$LK_MIN_VERSION"

# livekit-sip ships only as a container image; we extract the binary to the host so
# the unit needs no Docker at run time. It is dynamically linked, so its libraries
# must resolve — a missing libopusfile is the one that actually bites.
if [[ ! -x "$SIP_BIN" ]]; then
  cat >&2 <<EOF
✗ livekit-sip not found at $SIP_BIN
  It is distributed as a container image. Extract the binary once:
      cid=\$(docker create livekit/sip:latest)
      docker cp "\$cid":/usr/bin/livekit-sip "$SIP_BIN"
      docker rm "\$cid" && chmod +x "$SIP_BIN"
EOF
  exit 1
fi
if missing="$(ldd "$SIP_BIN" 2>/dev/null | awk '/not found/{print $1}')" && [[ -n "$missing" ]]; then
  die "livekit-sip is missing shared libraries: ${missing//$'\n'/ }
  On Debian/Ubuntu the usual culprit is libopusfile: sudo apt-get install -y libopusfile0"
fi
say "livekit-sip present, all shared libraries resolve"

redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1 || die "redis not answering on 127.0.0.1:6379"
say "redis reachable (this deployment uses db 3)"

# Ports must be free, OR already held by our own units (a re-run).
for port in 7890 7891; do
  if ss -ltn 2>/dev/null | grep -q ":$port "; then
    if ! systemctl --user is-active --quiet papercusp-phone-livekit.service; then
      die "port $port is in use by something that is not our LiveKit unit — refusing to fight over it"
    fi
    say "port $port already held by our own unit (re-run)"
  fi
done

# The other project on this host owns 7880/7881/5060. Never touch those.
if ss -ltn 2>/dev/null | grep -qE ':(7880|7881) '; then
  say "note: another project's LiveKit is on 7880/7881 — leaving it strictly alone"
fi

fi
LAN_IFACE="${PHONE_LAN_IFACE:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')}"
[[ -n "$LAN_IFACE" ]] || die "could not determine the LAN interface from the default route"
[[ "$LAN_IFACE" =~ ^[a-zA-Z0-9_.:-]+$ ]] || die "invalid LAN interface"
say "LAN interface: $LAN_IFACE"

# ---------------------------------------------------------------- credentials
step "Credentials"
mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"

if [[ ! -f "$ENV_FILE" || $ROTATE == 1 ]]; then
  [[ $ROTATE == 1 ]] && say "rotating API secret" || say "minting API key + secret (first run)"
  # generate-keys writes "API Key:  <k>" / "API Secret:  <s>" — capture without echoing.
  gen="$("$LK_BIN" generate-keys 2>/dev/null)"
  KEY="$(printf '%s' "$gen" | awk '/API Key:/{print $NF}')"
  SECRET="$(printf '%s' "$gen" | awk '/API Secret:/{print $NF}')"
  unset gen
  [[ -n "$KEY" && -n "$SECRET" ]] || die "could not parse a key pair out of 'livekit-server generate-keys'"
  write_livekit_credentials "$KEY" "$SECRET"
  unset KEY SECRET
  say "wrote $ENV_FILE (0600) — secret not printed"
else
  say "reusing existing key pair in $ENV_FILE"
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
[[ -n "${PHONE_LIVEKIT_API_KEY:-}" && -n "${PHONE_LIVEKIT_API_SECRET:-}" ]] \
  || die "$ENV_FILE is missing PHONE_LIVEKIT_API_KEY / PHONE_LIVEKIT_API_SECRET"
say "API credentials present (withheld)"

if [[ $RENDER_ONLY == 0 ]]; then
  ensure_worker_secret
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
elif ! grep -qE '^PHONE_WORKER_SECRET=.+' "$ENV_FILE"; then
  say "note: PHONE_WORKER_SECRET absent; a full deploy mints it (render-only never mints)"
fi

# Internal control and browser signalling are two views of the same media
# plane. Local installs use loopback for both. Hosted installs keep the worker
# and RoomService client on the internal URL while returning public WSS to the
# browser; conflating them either leaks loopback to visitors or hairpins the
# sidecar through its own public edge.
PHONE_LIVEKIT_URL="${REQUESTED_LIVEKIT_URL:-${PHONE_LIVEKIT_URL:-ws://127.0.0.1:7890}}"
PHONE_LIVEKIT_PUBLIC_URL="${REQUESTED_LIVEKIT_PUBLIC_URL:-${PHONE_LIVEKIT_PUBLIC_URL:-}}"
[[ "$PHONE_LIVEKIT_URL" =~ ^wss?://[^[:space:]]+$ ]] \
  || die "PHONE_LIVEKIT_URL must be a ws:// or wss:// URL"
if [[ -n "$PHONE_LIVEKIT_PUBLIC_URL" && ! "$PHONE_LIVEKIT_PUBLIC_URL" =~ ^wss?://[^[:space:]]+$ ]]; then
  die "PHONE_LIVEKIT_PUBLIC_URL must be a ws:// or wss:// URL"
fi
for key in "${MEDIA_KEYS[@]}"; do
  [[ ! -v REQUESTED_MEDIA[$key] ]] || printf -v "$key" '%s' "${REQUESTED_MEDIA[$key]}"
  export "$key"
done
export PHONE_LIVEKIT_URL PHONE_LIVEKIT_PUBLIC_URL
MEDIA_ARGS=()
[[ $HOSTED == 0 ]] || MEDIA_ARGS+=(--hosted)
PHONE_TURN_TLS_CONFIG="$("$NODE_BIN" "$HERE/media-config.mjs" turn-config "${MEDIA_ARGS[@]}")" \
  || die "public media prerequisites failed; configuration was not changed"
PHONE_LIVEKIT_INTERFACES="$(PHONE_LAN_IFACE="$LAN_IFACE" "$NODE_BIN" "$HERE/edge/edge-config.mjs" livekit-interfaces)" \
  || die "LiveKit media interface is invalid; configuration was not changed"
if [[ $HOSTED == 1 && $RENDER_ONLY == 0 ]]; then
  "$NODE_BIN" "$HERE/media-config.mjs" public-dns \
    || die "hosted media DNS is not public; refusing runtime convergence"
fi
upsert_env_var "PHONE_LIVEKIT_URL" "$PHONE_LIVEKIT_URL"
if [[ -n "$PHONE_LIVEKIT_PUBLIC_URL" ]]; then
  upsert_env_var "PHONE_LIVEKIT_PUBLIC_URL" "$PHONE_LIVEKIT_PUBLIC_URL"
fi
for key in "${MEDIA_KEYS[@]}"; do
  [[ -z "${!key:-}" ]] || upsert_env_var "$key" "${!key}"
done
say "internal LiveKit URL: $PHONE_LIVEKIT_URL"
if [[ -n "$PHONE_LIVEKIT_PUBLIC_URL" ]]; then
  say "browser LiveKit URL: $PHONE_LIVEKIT_PUBLIC_URL"
fi

# ---------------------------------------------------------------- render
# Pure-bash substitution: no sed escaping hazards with base64 secrets.
render() {
  local tmpl="$1" out="$2" content
  content="$(cat "$tmpl")"
  content="${content//'${PHONE_LIVEKIT_API_KEY}'/$PHONE_LIVEKIT_API_KEY}"
  content="${content//'${PHONE_LIVEKIT_API_SECRET}'/$PHONE_LIVEKIT_API_SECRET}"
  content="${content//'${PHONE_TURN_TLS_CONFIG}'/$PHONE_TURN_TLS_CONFIG}"
  content="${content//'${PHONE_LIVEKIT_INTERFACES}'/$PHONE_LIVEKIT_INTERFACES}"
  content="${content//'${PHONE_WORKER_DIR}'/$WORKER_DIR}"
  content="${content//'${PHONE_SIDECAR_DIR}'/$SIDECAR_DIR}"
  content="${content//'${PHONE_NODE_BIN}'/$NODE_BIN}"
  content="${content//'${PHONE_ALERT_SCRIPT}'/$HERE/phone-ops-alert.mjs}"
  content="${content//'${PHONE_BACKUP_SCRIPT}'/$HERE/phone-db-backup.mjs}"
  content="${content//'${PHONE_VINTAGE_SCRIPT}'/$HERE/report-runtime-vintage.mjs}"
  content="${content//'${PHONE_CONFIG_DIR}'/$CONF_DIR}"
  # Only a real placeholder counts: ${UPPER_SNAKE}. Prose that merely mentions a
  # dollar-brace must not trip this, or the guard cries wolf on its own comments.
  local leftover
  leftover="$(printf '%s' "$content" | grep -oE '\$\{[A-Z][A-Z0-9_]*\}' | sort -u | tr '\n' ' ' || true)"
  if [[ -n "${leftover// /}" ]]; then
    die "unsubstituted placeholder(s) in $(basename "$tmpl"): $leftover — refusing to write a broken config"
  fi
  umask 077
  printf '%s\n' "$content" > "$out"
  chmod 600 "$out"
}

step "Render config"
render "$HERE/livekit-server.yaml.tmpl" "$CONF_DIR/livekit-server.yaml"
render "$HERE/livekit-sip.yaml.tmpl"    "$CONF_DIR/livekit-sip.yaml"
say "rendered livekit-server.yaml + livekit-sip.yaml into $CONF_DIR"
if [[ $RENDER_ONLY == 1 ]]; then
  say "configuration prepared only; no runtime, DNS, firewall or audio acceptance claimed"
  exit 0
fi

# ---------------------------------------------------------------- units
step "Install units"
mkdir -p "$UNIT_DIR"
for u in "${UNITS[@]}"; do install -m 644 "$HERE/systemd/$u" "$UNIT_DIR/$u"; say "installed $u"; done
render "$HERE/systemd/papercusp-phone-ops-alert.service.tmpl" "$UNIT_DIR/papercusp-phone-ops-alert.service"
chmod 644 "$UNIT_DIR/papercusp-phone-ops-alert.service"
install -m 644 "$HERE/systemd/papercusp-phone-ops-alert.timer" "$UNIT_DIR/papercusp-phone-ops-alert.timer"
render "$HERE/systemd/papercusp-phone-backup.service.tmpl" "$UNIT_DIR/papercusp-phone-backup.service"
chmod 644 "$UNIT_DIR/papercusp-phone-backup.service"
install -m 644 "$HERE/systemd/papercusp-phone-backup.timer" "$UNIT_DIR/papercusp-phone-backup.timer"
write_ops_alert_env "$PHONE_BACKUP_ARCHIVE" "$PHONE_BACKUP_MAX_AGE_HOURS"
say "Phone backups go to $PHONE_BACKUP_ARCHIVE (stale after ${PHONE_BACKUP_MAX_AGE_HOURS}h) via $OPS_ALERT_ENV_FILE"

# The worker unit is RENDERED (machine paths), and only when the worker tree is
# actually present. Installing a unit whose WorkingDirectory does not exist buys
# nothing but a crash-loop that StartLimitBurst then freezes — a confusing
# `failed` in the Phone pane instead of an honest "not installed here".
if [[ -d "$WORKER_DIR" ]]; then
  render "$HERE/systemd/$WORKER_UNIT.tmpl" "$UNIT_DIR/$WORKER_UNIT"
  chmod 644 "$UNIT_DIR/$WORKER_UNIT"   # render() writes 0600 for secret files; a unit is not one
  UNITS+=("$WORKER_UNIT")
  say "rendered $WORKER_UNIT (worker dir: $WORKER_DIR, node: $NODE_BIN)"
else
  say "SKIP $WORKER_UNIT — no worker tree at $WORKER_DIR (set PHONE_WORKER_DIR to override)"
fi

# The sidecar, on the same present-or-skip rule as the worker.
if [[ -d "$SIDECAR_DIR" ]]; then
  # Mint the portal↔sidecar secret ONCE and never rotate it silently: both sides
  # read this file, so regenerating it on every deploy would break a running
  # portal's bearer until someone restarted it with the new value.
  if [[ ! -s "$PORTAL_ENV_FILE" ]] || ! grep -q '^PHONE_AUTH_SECRET=' "$PORTAL_ENV_FILE" 2>/dev/null; then
    mkdir -p "$CONF_DIR"
    ( umask 077; printf 'PHONE_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" > "$PORTAL_ENV_FILE" )
    chmod 600 "$PORTAL_ENV_FILE"
    say "minted PHONE_AUTH_SECRET into $PORTAL_ENV_FILE (portal must be started with it)"
  fi
  render "$HERE/systemd/$SIDECAR_UNIT.tmpl" "$UNIT_DIR/$SIDECAR_UNIT"
  chmod 644 "$UNIT_DIR/$SIDECAR_UNIT"   # render() writes 0600 for secret files; a unit is not one
  UNITS+=("$SIDECAR_UNIT")
  say "rendered $SIDECAR_UNIT (sidecar dir: $SIDECAR_DIR, node: $NODE_BIN)"
else
  say "SKIP $SIDECAR_UNIT — no sidecar tree at $SIDECAR_DIR (set PHONE_SIDECAR_DIR to override)"
fi
systemctl --user daemon-reload

step "Start"
restart_marker="$(date +%s)"
for u in "${UNITS[@]}"; do
  systemctl --user enable "$u" >/dev/null 2>&1 || true
  systemctl --user restart "$u"
  say "restarted $u"
done
# Take the first backup BEFORE arming the alert, so its first run checks a real
# archive. A failed backup does not abort the deploy: the alert reports it.
systemctl --user enable --now papercusp-phone-backup.timer
# The backup finds the database through the discovery file the sidecar's embedded
# Postgres rewrites on every start. Started straight after the restart it ran before
# that rewrite and failed "Phone database discovery unavailable" (measured 2026-10-06:
# backup 17:04:30.9Z, discovery file 17:04:33.7Z). Wait, bounded, for THIS start's file.
if [[ " ${UNITS[*]} " == *" $SIDECAR_UNIT "* ]]; then
  phone_discovery="${PHONE_HOME:-$HOME/.papercusp-phone}/postgres.json"
  discovery_wait="${PHONE_DISCOVERY_WAIT_SEC:-60}"
  discovery_fresh=0
  for (( waited = 0; waited <= discovery_wait; waited++ )); do
    if [[ -f "$phone_discovery" ]] && (( $(stat -c %Y "$phone_discovery") >= restart_marker )); then
      discovery_fresh=1; break
    fi
    (( waited < discovery_wait )) && sleep 1
  done
  (( discovery_fresh == 1 )) \
    || say "WARN: no fresh Phone database discovery file at $phone_discovery after ${discovery_wait}s; backing up anyway"
fi
if systemctl --user start papercusp-phone-backup.service; then
  say "took a Phone database backup to $PHONE_BACKUP_ARCHIVE"
else
  say "WARN: the Phone database backup failed; the ops-alert backup check will report it (journalctl --user -u papercusp-phone-backup.service)"
fi
systemctl --user enable --now papercusp-phone-ops-alert.timer
say "armed Phone operations alerts; results require owner notification delivery"

# ---------------------------------------------------------------- health
step "Health"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[[ $ok == 1 ]] || {
  printf '\n--- last 20 log lines ---\n' >&2
  journalctl --user -u papercusp-phone-livekit.service -n 20 --no-pager >&2 || true
  die "LiveKit did not become healthy on $HEALTH_URL within 30s"
}
say "LiveKit healthy on $HEALTH_URL"

for _ in $(seq 1 15); do
  systemctl --user is-active --quiet papercusp-phone-sip.service && break
  sleep 1
done
if systemctl --user is-active --quiet papercusp-phone-sip.service; then
  say "SIP gateway active on :5070"
else
  printf '\n--- last 20 sip log lines ---\n' >&2
  journalctl --user -u papercusp-phone-sip.service -n 20 --no-pager >&2 || true
  die "SIP gateway failed to stay active"
fi

await_readiness 30
printf '\n✓ media plane deployed. Acceptance: infra/phone-app/verify-media-plane.sh\n'

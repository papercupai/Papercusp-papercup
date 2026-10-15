#!/usr/bin/env bash
# papercusp-script-snapshot.sh — run a shell script from an immutable
# per-invocation snapshot.
#
# systemd units in this repository execute scripts from the shared staging tree.
# Bash reads those scripts lazily, so an edit that lands while a long-running
# invocation is in progress can move the next byte offset and turn a valid
# program into a different program.  This launcher snapshots the entry script
# and every nested *.sh argument plus its adjacent runtime sidecars before
# starting work.
#
# The launcher snapshots itself first.  That keeps the short-lived dispatcher
# stable too, and makes this helper safe to edit while a service is starting.
set -uo pipefail

# Do not let a parent or prior nested invocation supply stale target identity.
unset PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_PATH PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_SHA256

hash_file() {
  local path="${1:-}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$path" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$path" | awk '{print $1}'
    return
  fi
  return 69
}

snapshot_file() {
  local source="${1:-}" destination="${2:-}" label="${3:-script}"
  local before after copied attempt

  for attempt in 1 2 3 4 5; do
    before="$(hash_file "$source")" || {
      echo "[script-snapshot] cannot hash $label before copy: $source" >&2
      return 69
    }
    rm -f -- "$destination" 2>/dev/null || true
    cp -p -- "$source" "$destination" || {
      echo "[script-snapshot] cannot copy $label: $source" >&2
      return 73
    }
    after="$(hash_file "$source")" || {
      echo "[script-snapshot] cannot hash $label after copy: $source" >&2
      return 69
    }
    copied="$(hash_file "$destination")" || {
      echo "[script-snapshot] cannot hash copied $label: $destination" >&2
      return 69
    }
    if [[ "$before" == "$after" && "$before" == "$copied" ]]; then
      return 0
    fi
  done

  echo "[script-snapshot] source changed while copying $label: $source" >&2
  return 75
}

# Copy many helpers from ONE directory with a constant number of processes
# (WI-10006358). snapshot_file costs ~8 forks per file, so a target beside ~275
# siblings (scripts/pc-heavy.sh) burned ~15s of CPU per launch. One hash pass
# before, one cp, one pass over the sources and the copies after; any
# disagreement (a helper edited mid-copy) falls back to snapshot_file's
# per-file retry loop, so the consistency guarantee is unchanged.
snapshot_batch() {
  local source_dir="${1:-}" destination_dir="${2:-}" label="${3:-helper}" name
  shift 3
  (( $# > 0 )) || return 0
  if command -v sha256sum >/dev/null 2>&1; then
    local before after copied
    if before="$(cd -- "$source_dir" && sha256sum -- "$@")" &&
      cp -p -- "${@/#/$source_dir/}" "$destination_dir/" &&
      after="$(cd -- "$source_dir" && sha256sum -- "$@")" &&
      copied="$(cd -- "$destination_dir" && sha256sum -- "$@")" &&
      [[ "$before" == "$after" && "$before" == "$copied" ]]; then
      return 0
    fi
  fi 2>/dev/null
  for name in "$@"; do
    snapshot_file "$source_dir/$name" "$destination_dir/$name" "$label $name" || return $?
  done
}

new_temp_dir() {
  mktemp -d "${TMPDIR:-/tmp}/papercusp-script-snapshot.XXXXXX" 2>/dev/null
}

# Freeze this launcher before it starts looking at the target.  The child keeps
# SELF_DIR in its environment so its EXIT trap can reclaim this directory after
# the target exits.
if [[ -z "${PAPERCUSP_SCRIPT_SNAPSHOT_SELF_COPIED:-}" ]]; then
  self_dir="$(new_temp_dir)" || {
    echo "[script-snapshot] unable to create self-snapshot directory" >&2
    exit 73
  }
  self_copy="$self_dir/papercusp-script-snapshot.sh"
  if snapshot_file "$0" "$self_copy" "launcher"; then
    export PAPERCUSP_SCRIPT_SNAPSHOT_SELF_COPIED=1
    export PAPERCUSP_SCRIPT_SNAPSHOT_SELF_DIR="$self_dir"
    exec bash "$self_copy" "$@"
  fi
  rm -rf -- "$self_dir" 2>/dev/null || true
  exit 75
fi

usage() {
  echo "usage: $0 SCRIPT.sh [ARG ...]" >&2
  exit 64
}

[[ "$#" -ge 1 ]] || usage

snapshot_root="$(new_temp_dir)" || {
  echo "[script-snapshot] unable to create invocation snapshot directory" >&2
  exit 73
}
# Lets a target tell that it is running from this snapshot rather than in place, and so
# honour a checkout override only then (apps/operator/bin/bundle-host.sh, WI-10006398). A
# script run in place never sits under this root, so the value is inert if inherited.
export PAPERCUSP_SCRIPT_SNAPSHOT_ROOT="$snapshot_root"
self_dir="${PAPERCUSP_SCRIPT_SNAPSHOT_SELF_DIR:-}"

cleanup() {
  local status=$?
  trap - EXIT
  rm -rf -- "$snapshot_root" 2>/dev/null || true
  if [[ -n "$self_dir" && "$self_dir" != "$snapshot_root" ]]; then
    rm -rf -- "$self_dir" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

resolve_path() {
  local path="${1:-}" dir base
  dir="$(dirname -- "$path")"
  base="$(basename -- "$path")"
  (
    cd -- "$dir" 2>/dev/null || exit 1
    printf '%s/%s\n' "$PWD" "$base"
  )
}

declare -A snapshots=()
snapshot_index=0

# EI-25898717052240161: opt-in COMMITTED-source mode. A unit that deploys committed code
# (papercup-staging-sync) must not run an uncommitted edit of its own script. Such an edit
# is live the moment it is saved, while every module the script imports resolves inside the
# committed candidate checkout, so one new import of an uncommitted export failed every run
# and froze :3170 on its old build for 2.5 h (2026-10-13 19:05-21:37Z).
# With PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF=<ref>, the target, its adjacent *.sh/*.mjs helpers
# and lib/*.sh come from the commit <ref> names when the target is snapshotted. A target
# outside a git work tree, an unresolvable ref, or a path absent at that commit falls back to
# the working-tree copy, with a log line. All output goes to stderr: stdout is the path.
snapshot_ref="${PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF:-}"

snapshot_from_git() {
  local source="${1:-}" destination_dir="${2:-}" base="${3:-}"
  local root rel rel_dir sha extract src_dir helper
  local prefix
  root="$(git -C "$(dirname -- "$source")" rev-parse --show-toplevel 2>/dev/null)" &&
    prefix="$(git -C "$(dirname -- "$source")" rev-parse --show-prefix 2>/dev/null)" || {
    echo "[script-snapshot] $source is not in a git work tree; using the working-tree copy" >&2
    return 1
  }
  # --show-prefix is relative to the top level however the path was spelled (symlinks too).
  rel="${prefix}${base}"
  rel_dir="${prefix%/}"
  [[ -n "$rel_dir" ]] || rel_dir="."
  sha="$(git -C "$root" rev-parse --verify --quiet "${snapshot_ref}^{commit}" 2>/dev/null)" || sha=""
  if [[ -z "$sha" ]]; then
    echo "[script-snapshot] cannot resolve $snapshot_ref in $root; using the working-tree copy of $rel" >&2
    return 1
  fi
  if ! git -C "$root" cat-file -e "$sha:$rel" 2>/dev/null; then
    echo "[script-snapshot] $rel is not in $snapshot_ref@${sha:0:10}; using the working-tree copy" >&2
    return 1
  fi
  extract="$destination_dir.git-extract"
  rm -rf -- "$extract" 2>/dev/null || true
  mkdir -p -- "$extract" || return 1
  if ! git -C "$root" archive --format=tar "$sha" -- "$rel_dir" | tar -x -C "$extract" -f -; then
    echo "[script-snapshot] cannot extract $rel_dir at ${sha:0:10}; using the working-tree copy" >&2
    rm -rf -- "$extract" 2>/dev/null || true
    return 1
  fi
  src_dir="$extract/$rel_dir"
  cp -p -- "$src_dir/$base" "$destination_dir/$base" || { rm -rf -- "$extract"; return 1; }
  for helper in "$src_dir"/*.sh "$src_dir"/*.mjs; do
    [[ -f "$helper" && "${helper##*/}" != "$base" ]] || continue
    cp -p -- "$helper" "$destination_dir/" || { rm -rf -- "$extract"; return 1; }
  done
  if [[ -d "$src_dir/lib" ]]; then
    mkdir -p -- "$destination_dir/lib" || { rm -rf -- "$extract"; return 1; }
    for helper in "$src_dir"/lib/*.sh; do
      [[ -f "$helper" ]] || continue
      cp -p -- "$helper" "$destination_dir/lib/" || { rm -rf -- "$extract"; return 1; }
    done
  fi
  rm -rf -- "$extract" 2>/dev/null || true
  if cmp -s -- "$source" "$destination_dir/$base"; then
    echo "[script-snapshot] $rel from $snapshot_ref@${sha:0:10}" >&2
  else
    echo "[script-snapshot] $rel: working tree differs from $snapshot_ref@${sha:0:10}; running the committed version" >&2
  fi
  return 0
}

snapshot_script() {
  local source_token="${1:-}" source source_dir base destination_dir destination sidecar
  source="$(resolve_path "$source_token")" || {
    echo "[script-snapshot] cannot resolve script path: $source_token" >&2
    return 64
  }
  [[ -f "$source" ]] || {
    echo "[script-snapshot] script does not exist: $source_token" >&2
    return 64
  }

  if [[ -n "${snapshots["$source"]+present}" ]]; then
    printf '%s\n' "${snapshots["$source"]}"
    return 0
  fi

  source_dir="$(dirname -- "$source")"
  base="$(basename -- "$source")"
  snapshot_index=$((snapshot_index + 1))
  destination_dir="$snapshot_root/script-$snapshot_index"
  mkdir -p -- "$destination_dir" || return 73
  destination="$destination_dir/$base"

  if [[ -n "$snapshot_ref" ]] && snapshot_from_git "$source" "$destination_dir" "$base"; then
    snapshots["$source"]="$destination"
    printf '%s\n' "$destination"
    return 0
  fi

  snapshot_file "$source" "$destination" "target $base" || return $?

  # Setup-release-checkout sources dependency-generation.sh and invokes
  # pinned-lock-deps.mjs beside itself via BASH_SOURCE. Preserve adjacent shell
  # and Node helpers in the same directory; copying only the entry script
  # changes that path to this private snapshot directory and drops its helpers.
  local -a helpers=()
  while IFS= read -r -d '' sidecar; do
    [[ "$sidecar" == "$source" ]] && continue
    helpers+=("${sidecar##*/}")
  done < <(find "$source_dir" -maxdepth 1 -type f \( -name '*.sh' -o -name '*.mjs' \) -print0 2>/dev/null)
  snapshot_batch "$source_dir" "$destination_dir" "adjacent helper" ${helpers[@]+"${helpers[@]}"} || return $?

  # Health checks source lib/red-marker.sh through BASH_SOURCE. Preserve the
  # existing subdirectory layout for those shell sidecars too.
  if [[ -d "$source_dir/lib" ]]; then
    mkdir -p -- "$destination_dir/lib" || return 73
    helpers=()
    while IFS= read -r -d '' sidecar; do
      helpers+=("${sidecar##*/}")
    done < <(find "$source_dir/lib" -maxdepth 1 -type f -name '*.sh' -print0 2>/dev/null)
    snapshot_batch "$source_dir/lib" "$destination_dir/lib" "sidecar" ${helpers[@]+"${helpers[@]}"} || return $?
  fi

  snapshots["$source"]="$destination"
  printf '%s\n' "$destination"
}

argv=("$1" "${@:2}")
primary_snapshot_seen=0
for index in "${!argv[@]}"; do
  case "${argv[$index]}" in
    *.sh)
      if [[ -f "${argv[$index]}" ]]; then
        source_token="${argv[$index]}"
        snapshot_path="$(snapshot_script "$source_token")" || exit $?
        if [[ "$primary_snapshot_seen" = 0 ]]; then
          primary_source_path="$(resolve_path "$source_token")" || exit 64
          primary_snapshot_sha256="$(hash_file "$snapshot_path")" || {
            echo "[script-snapshot] cannot hash target snapshot: $snapshot_path" >&2
            exit 69
          }
          export PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_PATH="$primary_source_path"
          export PAPERCUSP_SCRIPT_SNAPSHOT_SOURCE_SHA256="$primary_snapshot_sha256"
          printf '[script-snapshot] target source=%s sha256=%s\n' \
            "$primary_source_path" "$primary_snapshot_sha256" >&2
          primary_snapshot_seen=1
        fi
        argv[$index]="$snapshot_path"
      fi
      ;;
  esac
done

# The committed-source mode applies to THIS launcher's targets only. A nested launch from
# inside the target (e.g. staging-sync snapshotting setup-release-checkout.sh in a candidate
# checkout) keeps its existing working-tree behaviour unless its own caller opts in.
unset PAPERCUSP_SCRIPT_SNAPSHOT_GIT_REF

# Keep the wrapper process alive until the target exits so the EXIT trap can
# remove the private snapshot tree, while preserving the target's exit status.
set +e
bash "${argv[0]}" "${argv[@]:1}"
status=$?
exit "$status"

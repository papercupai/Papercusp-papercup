#!/usr/bin/env bash
# WI-10005960 — keep the bake's rootful podman storage bounded, and refuse to start a bake the
# disk cannot hold.
#
# WHY. bake-cloud-images.sh builds into rootful podman storage (graphroot /var/lib/containers/storage,
# on the ROOT filesystem) and never removed anything. Every bake left its image, its superseded tags
# and its untagged build-cache layers behind; a killed `podman run` left an anonymous volume behind.
# Measured 2026-10-05: 107 images / 25 GB and 19 orphan anonymous volumes / 7.7 GB, all reclaimable,
# on a root disk whose exhaustion had already tripped git-sync's fetch-headroom refusal fleet-wide
# (2026-10-03). Nothing in the bake measured free space before writing tens of GB.
#
# WHAT IS KEPT (the safety half — this runs on a shared box where peers bake concurrently):
#   * every --keep-tag (the bake's own tag, and a local source image it reuses), always;
#   * the BAKE_KEEP_RECENT newest OTHER tags of --repo (default 2: the previous good bake stays
#     available for a re-render or a rollback);
#   * ANY image or dangling layer younger than BAKE_PROTECT_MIN minutes (default 240) — that is a
#     concurrent peer's in-flight bake, or this bake's own build cache;
#   * anything a container uses (`podman rmi` / `volume rm` are never forced, so podman refuses);
#   * every named volume (only 64-hex ANONYMOUS volumes with no container are removed).
#
# Usage:
#   bake-storage-hygiene.sh prune --repo <registry>/<name> [--keep-tag <tag>]...
#   bake-storage-hygiene.sh precheck [<extra path> ...]
#
# prune ALWAYS exits 0: hygiene must never fail a bake. Problems are reported as
# BAKE_STORAGE_PRUNE_WARN lines and the totals as one BAKE_STORAGE_PRUNE line.
# precheck exits 1 (BAKE_RESULT=FAILED storage-headroom ...) when podman's graphroot filesystem, or
# the filesystem of any extra path (the bake's --out), has less than BAKE_MIN_FREE_GIB free
# (default 64), and 2 when it cannot measure — an unmeasured disk is not a roomy one.
#
# Test seams: BAKE_STORAGE_HYGIENE_NOW (epoch seconds standing in for "now").
set -uo pipefail

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi

KEEP_RECENT="${BAKE_KEEP_RECENT:-2}"
PROTECT_MIN="${BAKE_PROTECT_MIN:-240}"
MIN_FREE_GIB="${BAKE_MIN_FREE_GIB:-64}"
NOW="${BAKE_STORAGE_HYGIENE_NOW:-$(date +%s)}"

for n in "$KEEP_RECENT" "$PROTECT_MIN" "$MIN_FREE_GIB" "$NOW"; do
  case "$n" in ''|*[!0-9]*) echo "bake-storage-hygiene: expected a non-negative integer, got '$n'" >&2; exit 2;; esac
done

warn() { echo "BAKE_STORAGE_PRUNE_WARN $*"; }

# Free GiB on the filesystem holding $1 (walks up to the nearest existing ancestor, so a --out that
# the bake has not created yet is measured where it will be created). Empty output = unmeasurable.
free_gib() {
  local p="$1"
  while [ -n "$p" ] && [ ! -e "$p" ]; do
    [ "$p" = "/" ] && break
    p="$(dirname -- "$p")"
  done
  df -P -B1G -- "$p" 2>/dev/null | awk 'NR==2 && $4 ~ /^[0-9]+$/ {print $4}'
}

cmd_precheck() {
  local graphroot avail target rc=0
  graphroot="$("${PODMAN[@]}" info --format '{{.Store.GraphRoot}}' 2>/dev/null)"
  if [ -z "$graphroot" ]; then
    echo "BAKE_RESULT=FAILED storage-headroom could not read podman's graphroot (podman info failed); an unmeasured disk is not a roomy one"
    return 2
  fi
  for target in "$graphroot" "$@"; do
    avail="$(free_gib "$target")"
    if [ -z "$avail" ]; then
      echo "BAKE_RESULT=FAILED storage-headroom could not measure free space for $target"
      return 2
    fi
    echo "BAKE_STORAGE_HEADROOM path=$target freeGiB=$avail minGiB=$MIN_FREE_GIB"
    if [ "$avail" -lt "$MIN_FREE_GIB" ]; then
      echo "BAKE_RESULT=FAILED storage-headroom ${avail}GiB free for $target, need >= ${MIN_FREE_GIB}GiB (BAKE_MIN_FREE_GIB); run bake-storage-hygiene.sh prune or free space first"
      rc=1
    fi
  done
  return "$rc"
}

cmd_prune() {
  local repo="" keep_tag="" keep_tags=" "
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:-}"; shift 2;;
      # Repeatable: the bake keeps its own tag AND the local source image it is about to reuse.
      --keep-tag) keep_tag="${keep_tag:+$keep_tag,}${2:-}"; keep_tags="$keep_tags${2:-} "; shift 2;;
      *) warn "unknown argument $1 (prune skipped)"; return 0;;
    esac
  done
  if [ -z "$repo" ]; then warn "--repo is required (prune skipped)"; return 0; fi

  local protect_sec=$(( PROTECT_MIN * 60 ))
  local removed_tags=0 refused_tags=0 kept_tags=0 removed_volumes=0 refused_volumes=0
  local listing line image_repo tag created age recent=0

  # Newest first. `{{.Created}}` here is a human string ("2 hours ago"), so the epoch comes from
  # inspect, which renders the time.Time field.
  # Podman's reference filter selects images, then lists ALL their aliases,
  # including tags in another repository. Inspect only our actual aliases.
  if ! listing="$("${PODMAN[@]}" images --filter "reference=$repo" --noheading --format '{{.Repository}} {{.Tag}}' 2>&1)"; then
    warn "could not list $repo images: $listing"
    listing=""
  fi
  local rows=()
  while IFS=' ' read -r image_repo tag; do
    [ "$image_repo" = "$repo" ] || continue
    [ -z "$tag" ] || [ "$tag" = "<none>" ] && continue
    created="$("${PODMAN[@]}" image inspect --format '{{.Created.Unix}}' "$repo:$tag" 2>/dev/null)"
    case "$created" in ''|*[!0-9]*) warn "could not read the creation time of $repo:$tag (kept)"; kept_tags=$((kept_tags + 1)); continue;; esac
    rows+=("$created $tag")
  done <<< "$listing"

  if [ "${#rows[@]}" -gt 0 ]; then
    while IFS=' ' read -r created tag; do
      age=$(( NOW - created ))
      if [[ "$keep_tags" == *" $tag "* ]] || [ "$age" -lt "$protect_sec" ]; then
        kept_tags=$((kept_tags + 1)); continue
      fi
      if [ "$recent" -lt "$KEEP_RECENT" ]; then
        recent=$((recent + 1)); kept_tags=$((kept_tags + 1)); continue
      fi
      if "${PODMAN[@]}" rmi "$repo:$tag" >/dev/null 2>&1; then
        removed_tags=$((removed_tags + 1))
      else
        refused_tags=$((refused_tags + 1)); warn "podman refused to remove $repo:$tag (in use?) — kept"
      fi
    done < <(printf '%s\n' "${rows[@]}" | sort -rn)
  fi

  # Untagged layers older than the protection window: superseded build cache, and the parents of
  # the tags just removed. podman's prune repeats until no dangling image remains.
  if ! "${PODMAN[@]}" image prune -f --filter "until=${PROTECT_MIN}m" >/dev/null 2>&1; then
    warn "podman image prune failed"
  fi

  # Anonymous (64-hex) volumes with no container: left by a container that was removed without -v.
  local vols vol
  if vols="$("${PODMAN[@]}" volume ls --filter dangling=true --format '{{.Name}}' 2>&1)"; then
    while IFS= read -r vol; do
      [[ "$vol" =~ ^[0-9a-f]{64}$ ]] || continue
      if "${PODMAN[@]}" volume rm "$vol" >/dev/null 2>&1; then
        removed_volumes=$((removed_volumes + 1))
      else
        refused_volumes=$((refused_volumes + 1))
      fi
    done <<< "$vols"
  else
    warn "could not list dangling volumes: $vols"
  fi

  echo "BAKE_STORAGE_PRUNE repo=$repo keepTag=${keep_tag:-none} removedTags=$removed_tags keptTags=$kept_tags refusedTags=$refused_tags removedVolumes=$removed_volumes refusedVolumes=$refused_volumes"
  return 0
}

case "${1:-}" in
  precheck) shift; cmd_precheck "$@"; exit $?;;
  prune) shift; cmd_prune "$@"; exit 0;;
  *) echo "usage: $0 prune --repo <repo> [--keep-tag <tag>] | precheck [<path> ...]" >&2; exit 2;;
esac

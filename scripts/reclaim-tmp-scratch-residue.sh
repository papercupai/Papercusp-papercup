#!/usr/bin/env bash
# Compatibility entry for the retired name-only scratch sweeper (WI-10000539).
# The existing diskRetentionReclaim schedule now owns tmp-scratch through
# runScheduledDiskReclaim: 4h age, leases, complete FD/cwd scans and fresh identity
# checks. /tmp and /mnt/data/tmp are the SAME physical class. Never put a second
# deleting actor here; old installed timers may continue invoking this entry.
set -uo pipefail

case "${1:-}" in
  -h|--help)
    echo 'Scratch retention is enforced by the scheduled diskRetentionReclaim workflow.'
    echo 'This compatibility entry performs no deletion, including with --execute.'
    ;;
  *)
    echo '[reclaim] delegated=diskRetentionReclaim class=tmp-scratch execute=0 legacy-actor-retired=1'
    ;;
esac

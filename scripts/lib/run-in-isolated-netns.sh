#!/usr/bin/env bash
# Compatibility entry point; the maintained implementation ships with the shared harness.
set -eu
ROOT="$(cd -- "${BASH_SOURCE[0]%/*}/../.." && pwd -P)"
exec bash "$ROOT/libs/generic/verification-harness/bin/run-in-isolated-netns.sh" "$@"

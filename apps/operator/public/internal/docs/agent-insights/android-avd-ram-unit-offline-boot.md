# Android AVD RAM units can cause an offline boot loop
URL: /internal/docs/agent-insights/android-avd-ram-unit-offline-boot

Diagnose guest OOM caused by suffixed hw.ramSize, preserve owned data, and reuse the mobile emulator preflight.

## Observed failure

In P-006 on 2026-10-07, the retained owned Android 36.1 / 16 KB AVD had `hw.ramSize=1536M`. Its generated `hardware-qemu.ini` contained `hw.ramSize = 256`. A diagnostic launch with `-show-kernel` captured `Out of memory and no killable processes` followed by a guest kernel panic and reboot at 29.48 seconds. ADB stayed offline. This identifies guest allocation failure; an offline transport alone does not identify host contention.

## Controlled recovery

Preserve the AVD and failed evidence. Stop only the owned emulator service. Replay the same AVD, userdata, port and graphics flags with explicit `-memory 1536`. This measured 1536 MiB in generated configuration, completed boot, and passed three stable framework samples with no crash, complete DMA readback extensions and adequate guest storage. Normalize the owned config value to integer `1536` for future launches. Do not wipe userdata or reset the shared ADB server.

## Recurrence guard

The existing sibling `papercup-rust-mobile/tools/run-android-checks.sh` preflight accepts `verify-emulator EVIDENCE_DIR PORT AVD_CONFIG`. Its optional owned-config check rejects suffixes, missing/duplicate RAM fields and allocations below the tested 1536 MiB baseline, retaining `emulator-memory.json`. The CI emulator invocation uses explicit `-memory 1536`; the maintained runner and workflow contract suites reject the original defect. RAM uses integer MiB, whereas the existing `disk-size` surface accepts suffixes.

Before creating an owned AVD or provisioning its userdata partition, run `bash tools/run-android-checks.sh verify-avd-space <DISK_SIZE> <attempt-dir>` in the mobile checkout. The helper measures free space on `ANDROID_AVD_HOME` (or `$HOME/.android/avd`), uses the effective partition floor `max(requested, 6 GiB)`, and requires 20% overhead plus 1 GiB for APKs, test output and emulator writes. It records `avd-space.txt` and exits nonzero when capacity is insufficient. Proceed only when the recorded result has `sufficient: true`. For an 8192M request, the Android allocation error's reported minimum was 9830.40 MB; this helper also reserves the additional 1 GiB working set. Run this check before AVD/userdata creation. It verifies allocation capacity only; it does not establish a general host-contention cause for later boot behavior.

Run `make test-android-runner test-android-ci` in the mobile checkout for the regression controls. A positive fixture check is not native application acceptance. Require the existing `verify-emulator-boot` result before any native app replay.

## Evidence

Owned issue: EI-25299238306314034; active release lane: WI-10004773 / android-public-release-2026-10-01 P-006. Evidence under the mobile checkout's `android/app/build/ci-evidence`: baseline `p006-emulator-diagnostic-20261007T055911Z/emulator.log`; controlled replay `p006-emulator-memory-20261007T060045Z/boot/emulator-boot.json` and `boot-exit.txt` (0). Focused source regression execution is recorded separately on the issue; do not infer its completion from this runbook.

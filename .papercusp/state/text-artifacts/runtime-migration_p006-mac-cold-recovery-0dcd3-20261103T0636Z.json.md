---
rel_path: "runtime-migration/p006-mac-cold-recovery-0dcd3-20261103T0636Z.json"
updated_at: 1793688206795
_body: "content"
---

{
  "schemaVersion": 1,
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "parent": "WI-6554700010022072",
  "scope": "Mac retained-state recovery and ARM defect completion; no final Bun/default/installed matrix/shipment acceptance",
  "completedArmDefects": {
    "ids": [
      "EI-27724878596596626",
      "EI-27726528478534884",
      "EI-27732318756752684",
      "EI-27733084641734890"
    ],
    "state": "done",
    "completionAuthority": "committed",
    "receipt": "work_items:complete response2026-11-03; each successful, counts.ok4/failed0",
    "nativeProducerProof": "runtime-migration/p006-arm-sidecar-producer-8dfbd-0dcd3-20261103.json",
    "priorFullArchive": "runtime-migration/held-checkpoints-0dcd3-20261103T0355Z.json"
  },
  "clean2141Recovery": {
    "taskId": "0mw093fgew3t4it1gml",
    "state": "completed",
    "exitCode": 0,
    "endedAt": "2026-11-03T06:10:42.968Z",
    "nativeHealth": {
      "taskId": "0mw0a88zf12zx12m1wh",
      "sha": "a27e607e",
      "version": "0.0.26",
      "port": 3070,
      "at": "2026-11-03T06:03:54.420Z"
    },
    "baselineAlignment": {
      "taskId": "0mw0ac7361wvhioh1qo",
      "exitCode": 2,
      "reason": "PostgreSQL data volume954992KiB <1048576KiB; maintained preflight refused before push/install/relaunch",
      "log": "/mnt/data/tmp/bun-p006-mac-lifecycle-cold2141-0dcd3-20261103/baseline-align.log"
    },
    "shutdown": {
      "taskId": "0mw0afxmw1g4ugxy1fd",
      "exitCode": 0,
      "nativeHeadlessStopped": true,
      "nativeShutdownCommandExit": 0,
      "qmpClosed": true
    },
    "root": "/mnt/data/tmp/bun-p006-mac-cold-clean2141-0dcd3-20261103T0530Z",
    "disposition": "Preserved stopped; predates saved capacity repair; do not use for further candidate lifecycle without addressing that state mismatch"
  },
  "currentMac": {
    "taskId": "0mw0aidnt16wv4ud19c",
    "stateAtLaunch": "running",
    "qemuPid": 1218551,
    "deadline": "2026-11-03T12:11:38.537Z",
    "root": "/mnt/data/tmp/bun-p006-mac-cold-paused0335-0dcd3-20261103T0613Z",
    "baseReceipt": "/mnt/data/offload/bun-p006-mac-paused-retention-0dcd3-20261103T0335Z/receipt.json",
    "sourceRecovery": "Paused crash-consistent disk/firmware; no memory resume or clean source shutdown claim",
    "resourceLock": "173b7f6b-9892-4379-95c5-6751990a5aab",
    "lastVerifiedLockExpiresAt": "2026-11-03T07:26:31.315Z",
    "ssh": {
      "port": 2226,
      "user": "aviweiss",
      "host": "127.0.0.1",
      "hostKeyAlias": "bun-p006-verified-baseline-0dcd3",
      "knownHosts": "/mnt/data/tmp/bun-p006-mac-boot-diagnosis-0dcd3-20261102/native-recovery/verified-baseline-vm/known_hosts",
      "keyFile": "/home/marsh-office/.ssh/papercup-vm-mac",
      "strictHostKeyChecking": true
    },
    "nativeEvidence": {
      "console": "native-network-console.png: actual native22LISTEN IPv4+IPv6, en0=10.0.2.15, date2026-11-03T01:32:17EST",
      "preflightLog": ".papercusp/scratch/bash-2480a29d-954.log",
      "preflight": "PAPERCUSP_NATIVE_MAC_PREFLIGHT_OK",
      "pgDataSymlink": "/Volumes/BunAcceptanceData/embedded-pg-data",
      "installedServerBuildSha": "2018b667",
      "probeScope": "SSH+maintained preflight+symlink+build identity. Auxiliary /usr/bin/df path was wrong on macOS; no fresh numeric free-space claim."
    },
    "causeLimits": "Earlier SSH banner timeouts were real, then native console and SSH recovered. No cause established. Measured vCPU major faults and IO activity do not establish a resource bottleneck; cgroup memory limits are max and measured pressure was low.",
    "noRepeatedOperations": [
      "No full source transfer, npmci, unchanged test matrix or ARM producer rerun",
      "No full disk recopy, rehash, fsck, PG copy, APFS resize or memory migration",
      "No simultaneous VM on SSH2226",
      "Never print qemu-argv.json (contains OSK)"
    ]
  },
  "inFlightBaselineQualification": {
    "taskId": "0mw0bepdf1183ehw1pn",
    "log": ".papercusp/scratch/bash-82002818-0dd.log",
    "deadline": "2026-11-03T07:26:46.707Z",
    "receipt": "/mnt/data/tmp/bun-p006-mac-cold-paused0335-0dcd3-20261103T0613Z/baseline-qualification.json",
    "method": "Read-only exact mac_dmg_verify_installed_command from maintained install-and-relaunch-verify.sh for GUI and Server; match mounted baselineDMGs and strict codesign before starting installed2018 headless runtime.",
    "status": "FAILED/native1; GUI readonly verifier stopped before app changes or baseline health start",
    "result": {
      "taskId": "0mw0bepdf1183ehw1pn",
      "exitCode": 1,
      "role": "GUI",
      "stderr": "hdiutil: attach failed - No such file or directory",
      "scope": "Expected remote baseline DMG absent; no Server verification or health start executed."
    }
  },
  "acceptance": {
    "plan": "node-to-bun-staged-migration-2026-10-22",
    "revision": 45,
    "shipReadinessCode": "acceptance_bar_contract_not_ready",
    "evaluatorAvailable": true,
    "remaining": [
      "Full10nativeGUI/server cells and Bun activation",
      "Default eligibility and single ownership",
      "Canary60min soak and bidirectional rollback",
      "BAR and7-day retained Node window",
      "Final shipment"
    ],
    "liveGate": "Owned611f; useful evidence already sent once; do not enter LIVE_GATE_OPS"
  },
  "nextAction": "Adopt current newer Mac VM; stage retained signed2018b667 baseline GUI+Server DMGs at a capacity-qualified destination, preferably on BunAcceptanceData, using existing maintained streaming/reservation helpers. Then run the same exact readonly installed-tree qualification; do not repeat a missing-artifact invocation. Do not boot another VM or redo source/PG/fsck/copies."
}


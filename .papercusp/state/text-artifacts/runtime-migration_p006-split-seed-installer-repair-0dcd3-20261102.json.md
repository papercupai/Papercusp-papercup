---
rel_path: "runtime-migration/p006-split-seed-installer-repair-0dcd3-20261102.json"
updated_at: 1793611075393
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "EI-27665166651807560",
  "rootCause": "The producer split Server seed into a versioned companion while the candidate lifecycle, installer and vmctl still transported only GUI/Server; the Server filename glob also matched the seed.",
  "filesChanged": [
    "papercusp-desktop/bin/lib/release-artifacts.sh",
    "papercusp-desktop/bin/candidate-install-upgrade-rollback.sh",
    "papercusp-desktop/bin/install-and-relaunch-verify.sh",
    "papercusp-desktop/scripts/linux-test-vm/vmctl",
    "papercusp-desktop/test/candidate-install-upgrade.test.js",
    "papercusp-desktop/test/install-and-relaunch-verify.test.js",
    "papercusp-desktop/test/updater-e2e-vm.test.js"
  ],
  "repair": [
    "Reuse release-artifacts.sh for seed discovery and package/version/provenance hash validation before VM access",
    "Carry distinct candidate and baseline seed arrays to both verifier legs and baseline vmctl",
    "Install Server plus seeds in one apt transaction, including explicit downgrade opt-in; verify configured seed packages",
    "Bind seed digests into final lifecycle receipt using streaming package hashing",
    "Exclude seed filenames from Server installer auto-discovery"
  ],
  "tests": {
    "command": "node --test --test-global-setup=test/monorepo-host-preflight.mjs test/candidate-install-upgrade.test.js test/install-and-relaunch-verify.test.js test/updater-e2e-vm.test.js",
    "cwd": "papercusp-desktop",
    "passed": 152,
    "failed": 0,
    "skipped": 0,
    "exitCode": 0,
    "log": "/tmp/0dcd3-seed-tests-final.log",
    "logSha256": "6b83c697d6f7b12db3350e4e6d0c6734df53fd724edf7d53d9307aef6c3ee203",
    "logBytes": 14611
  },
  "newGuards": [
    "each lifecycle leg receives its own exact seed and evidence hash",
    "missing seed refuses before VM operation",
    "tampered seed refuses before VM operation",
    "wrong-version seed refuses before VM operation",
    "installer transfers seed and includes it with Server in same downgrade transaction",
    "configured seed checked before relaunch",
    "vmctl transfers the exact companion set and passes it to one guest apt transaction"
  ],
  "limits": "These are conventional framework tests of production orchestration with isolated transport fixtures. Real installed baseline/candidate rollback and full P006/BAR/native acceptance remain open; no shipment claimed."
}

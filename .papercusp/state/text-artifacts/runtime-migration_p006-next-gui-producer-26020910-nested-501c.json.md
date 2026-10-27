---
rel_path: "runtime-migration/p006-next-gui-producer-26020910-nested-501c.json"
updated_at: 1792820740709
_body: "content"
---

{
  "command": "set -euo pipefail\nP006_ROOT=/mnt/data/tmp/bun-p006-source-26020910-nested-501c\nP006_EXPECTED=26020910d4f35d642315efc81cd973811a6bb1f4\ntest \"$(git -C \"$P006_ROOT\" rev-parse HEAD)\" = \"$P006_EXPECTED\"\ngit -C \"$P006_ROOT\" diff --quiet HEAD\ngit -C \"$P006_ROOT\" submodule foreach --quiet --recursive 'git diff --quiet HEAD && test \"$(git rev-parse HEAD)\" = \"$sha1\"'\nprintf 'P006_GUI_FROZEN_SOURCE_CLEAN sha=%s\\n' \"$P006_EXPECTED\"\nP006_TOOL_INPUTS=\"$(sha256sum papercusp-desktop/bin/build-linux-local.sh papercusp-desktop/bin/build-desktop-sidecar.sh papercusp-desktop/bin/lib/pinned-deps.sh)\"\nexport REPO_ROOT=\"$P006_ROOT\"\nexport PAPERCUSP_DESKTOP_TARGET_ROOT=\"$P006_ROOT/papercusp-desktop\"\nexport PAPERCUSP_TRANSFORMERS_MODEL_CACHE=\"$HOME/.cache/papercusp-models\"\nexport PAPERCUSP_RELEASE_AUDIT=1 PAPERCUSP_BUILD_ROLES=gui PAPERCUSP_DISTRIBUTION_PROFILE=dogfood PAPERCUSP_SKIP_SEED_CUT=1\nexport TAURI_SIGNING_PRIVATE_KEY_PATH=\"$HOME/.papercusp/signing/papercusp.key\"\nexport PAPERCUSP_RELEASE_TAG=bun-p006-linux-26020910-nested-501c\nPC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh -- bash papercusp-desktop/bin/build-linux-local.sh\ntest \"$P006_TOOL_INPUTS\" = \"$(sha256sum papercusp-desktop/bin/build-linux-local.sh papercusp-desktop/bin/build-desktop-sidecar.sh papercusp-desktop/bin/lib/pinned-deps.sh)\"\nprintf 'P006_LINUX_GUI_PRODUCER_PASS\\n'",
  "executed": true,
  "source": "Existing maintained p006-next-gui-producer-ade5fa2e-501c command; changed frozen root, ref and unique tag only.",
  "taskPrerequisite": "0mvlyqxo9riym658wec",
  "requires": [
    "actual terminal native0/P006_FRESH_CANDIDATE_PREPARED",
    "source/dependency receipt bindings",
    "frozen clean source and exact pins"
  ],
  "scope": "Packaging reproduction only; no installed, seed freshness, signature, default or shipment acceptance.",
  "launchedTask": {
    "task_id": "0mvlz5oaq1wmllu61bu",
    "bash_id": "c1747bcf-fb5",
    "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-c1747bcf-fb5.log",
    "deadline": "2026-10-24T07:45:03.614Z"
  },
  "preparation": {
    "task_id": "0mvlyqxo9riym658wec",
    "status": "completed",
    "exit_code": 0,
    "sourceReceiptPath": "/mnt/data/tmp/bun-p006-source-26020910-nested-501c.receipt.json",
    "dependencyReceiptPath": "/mnt/data/tmp/bun-p006-source-26020910-nested-501c.dependencies.json",
    "bindingsEvidence": "Native exec 01f191: P006_PREP_RECEIPT_BINDINGS_PASS; source/ref/root/canonical receipt SHA256, policy and tested inputs asserted."
  }
}

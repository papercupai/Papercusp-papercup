---
rel_path: "security/p006-mac-privileged-helper-development-20261105T1849Z.json"
updated_at: 1793904509567
_body: "content"
---

{
  "schema": "p006-mac-privileged-helper-development-v1",
  "scope": "LOCAL working-source Linux native fixtures only; no SEC or signed installed acceptance",
  "at": "2026-11-05T18:49Z",
  "workItems": [
    "WI-6554700010044291",
    "WI-6554700010045189"
  ],
  "implementation": [
    "Root helper at fixed protected /Library/PrivilegedHelperTools/com.papercusp.update-installer; never elevate current_exe or caller executable.",
    "Reuse security-framework3.7.0 Authorization Services for macOS10.15 and existing native authorization/activation transaction; root rechecks CURRENT policy, commits monotonic floors, stages owned bytes under lock.",
    "Duplex bounded frame: REQUEST_END -> READY -> GUI quiesce -> COMMIT -> atomic exchange -> DONE; cancellation/disconnect fail without replacement, release lock and clean stage. NONBLOCK+poll bounds pipe to300s.",
    "GUI calls install_privileged after signed download; helper main accepts no args. Cargo default-run preserved, new papercusp-update-installer binary."
  ],
  "rootCause": "Initial full native suite failed because new installed-target fixture inherited measured umask0002 ->0775, correctly refused before READY. Explicit0755 plus exact cancellation-error assertion removes false positive.",
  "verification": {
    "before": "0mw3vdfyg17rjpaz1pb / .papercusp/scratch/bash-b296afb3-13f.log EXIT1; 4JS cases passed,1failed.",
    "focused": "0mw3vx77p6e5l401w2b / .papercusp/scratch/bash-b9720d1c-557.log EXIT0;1passed4filtered.",
    "final": "0mw3w92ry17eqtyi9hb / .papercusp/scratch/bash-b20c8671-2d8.log EXIT0;5passed0skipped. Real duplex+filesystem effect, cancel, current revocation, disconnect, invalid COMMIT, lock release, fixed helper ancestor/permission/symlink/hardlink/no-execute refusal, stalled read/write timeout.",
    "metadata": "cargo metadata --offline --locked --format-version1 EXIT0; diffchecks clean.",
    "types": "RUNNING task0mw3wci4qq2singao0x / .papercusp/scratch/bash-fdedf8ee-c42.log; do not duplicate.",
    "mac": "task0mw3wdqpr19ht3x5s7w / .papercusp/scratch/bash-938f7c52-38b.log EXIT101 before helper compile: ring/objc2 C builds used Linux cc, rejecting -arch/-mmacosx. Need canonical cross toolchain (build-mac-cross.sh uses cargo zigbuild), then both architectures."
  },
  "sourceSha256": {
    "packages/operator-core/lib/release/tauri-update-authorization-native.test.ts": "6565d6a782e8ae9765e7309723a28d6b0fefbbde810cb70cbc07ead32e66d632",
    "papercusp-desktop/src-tauri/src/macos_update_installer.rs": "751cd24bcbee5cb6e9c037a75a19cdcc30eb83a2b38b75bfb4b068ece316dc31",
    "papercusp-desktop/src-tauri/src/macos_update_helper.rs": "f4ae13cb440e6222ed1e1441eb554b5a69d66e617b8a91a233d5c692ded1a409",
    "papercusp-desktop/src-tauri/src/main.rs": "039307f1f86615a24ff391251b8c42192d1547fd047684a6f5e7f103a4432cd7",
    "papercusp-desktop/src-tauri/Cargo.toml": "5031a6df068ecfe61c2e4942bd650bc44c0b2a65d4b37e2ddd5b1ee44a881561",
    "papercusp-desktop/src-tauri/Cargo.lock": "7ac252144ce74da5a98b9ae937c3d0d663da4c535db45dc209a7222fed2a01be",
    "papercusp-desktop/src-tauri/src/update_authorization.rs": "be62a2d5aa4237670b0e03f298239c1439b0ea5f3c028cb1668730048c1e8116"
  },
  "remaining": [
    "Helper signing and protected provisioning/update in maintained release packaging; /Applications protection support design.",
    "Native Mac bootstrap/elevation/full GUI compilation and actual installed helper positive+negative proof on both supported architectures.",
    "Authenticated exact source and ALL authors (empty production authors REFUSE), other platform adapters, independent SEC/release review and exact signed installed shipment.",
    "Preserve all5parentchecks/full archivefd5d/original16requirements. Canonical start42 SUCCESS; never repeat start/audit or unchanged passing tests. No new implementers/LIVE_GATE_OPS."
  ],
  "locks": "All manual file locks released."
}

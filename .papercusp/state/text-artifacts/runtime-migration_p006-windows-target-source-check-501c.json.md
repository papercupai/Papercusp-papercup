---
rel_path: "runtime-migration/p006-windows-target-source-check-501c.json"
updated_at: 1792796998406
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010022072",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "item": "P-006",
  "plane": "local-windows-target-source-check",
  "command": "cargo xwin check --release --locked --target x86_64-pc-windows-msvc -p papercusp-desktop",
  "environment": {
    "TAURI_CONFIG": "{}"
  },
  "cwd": "papercusp-desktop/src-tauri",
  "log": "/tmp/bun-p006-windows-rust-check-501c.log",
  "logSha256": "895b39496acc3912f214b11eedd970249e6b90e7f68c550e553c570608e81367",
  "observation": "Cargo Finished release profile [optimized] target(s) in 1m36s; no error lines; pc-heavy status completed. 50 warnings recorded.",
  "nativeExit": "unknown: predecessor exec handle was not reused",
  "sourceInputHashes": "/tmp/bun-p006-real-input-hashes-501c.json; all eight hashes matched at 2026-10-23T23:09Z",
  "limits": [
    "Compile check only: not Windows execution, linking, final packaging or installed lifecycle acceptance.",
    "Node remains active; final migration acceptance and shipment open."
  ]
}

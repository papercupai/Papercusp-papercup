---
rel_path: "evidence/p002/portal-source-graph-preflight-20261025.json"
updated_at: 1792906964761
_body: "content"
---

{
  "schemaVersion": "desktop-portal-source-preflight-v1",
  "preparedAt": "2026-10-25T05:41:48.605Z",
  "ok": true,
  "sourceFingerprint": "685f65f6bad6c8ef8be54313e255068f6badc72bd3187a0dd05f872176c70434",
  "sourceInputs": [
    {
      "path": "app/globals.css",
      "sha256": "88744af9fe75d681834bb5aeaed82fef7172e0e302864dc46d68a1170a763e24"
    },
    {
      "path": "app/tokens.css",
      "sha256": "956a7e727acee15f2bfcff0d58eb3288bf5f4ee7da3ec2692a4499a7c421b9b6"
    },
    {
      "path": "packages/contracts/package.json",
      "sha256": "09470da3192a5ef458f66c01ded5b441a8e9824af0abe37b0a287b4698f2644b"
    },
    {
      "path": "packages/contracts/src/index.ts",
      "sha256": "ca333905916a835eebbd0e8e38953dd490e0c7f2fe35bc99dad63fe3cd0d4b1e"
    },
    {
      "path": "packages/ui/package.json",
      "sha256": "88c9926def1e9f3abcbd9dae21f1c16b9c57fbcc0aa5e193fda94350debd3de3"
    },
    {
      "path": "packages/ui/src/index.tsx",
      "sha256": "d8a8ab99fefc606414e2783514235abb66bc1745dd8dad56371353d0bfa1f5b0"
    },
    {
      "path": "packages/ui/src/shell.tsx",
      "sha256": "a903e00bcf749e8e2ff842f0171e956994c5159f9b864d3be637da8c87831ffa"
    }
  ],
  "graphInputCount": 18216,
  "outputCount": 542,
  "outputBytes": 56732362,
  "outputSetFingerprint": "9afb8221269388fac1543c42844ab900fcbccd228928bd42cfb35329b40d5bd0",
  "nativeInputs": [
    "node_modules/@tauri-apps/api/external/tslib/tslib.es6.cjs",
    "node_modules/@tauri-apps/api/core.cjs",
    "node_modules/@tauri-apps/api/dpi.cjs",
    "node_modules/@tauri-apps/api/event.cjs",
    "node_modules/@tauri-apps/api/image.cjs",
    "node_modules/@tauri-apps/api/window.cjs"
  ],
  "browserNativeShims": [],
  "warnings": [
    {
      "text": "\"@charset\" must be the first rule in the file",
      "file": "node_modules/dockview-react/dist/styles/dockview.css",
      "line": 2839
    }
  ],
  "scope": "In-memory shared UI and CSS compilation. Desktop bootstrap, API host composition, installed behavior and publication remain unverified.",
  "outputsWritten": false
}

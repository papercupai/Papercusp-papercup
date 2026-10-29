---
rel_path: "git-sync/content-errors/88ffa70de32a69aea97f57d8feb79751a9035b3929950a4ea6afcd2484c559bb.json"
updated_at: 1793254066471
_body: "content"
---

{"schemaVersion":1,"workspaceId":"papercusp-workspace","harness":"papercusp","files":[{"scope":"superproject","file":"docs/evidence/r2-to-gcs-storage-migration-2026-10-23/p004-checkpoint-before-provider-binding-2026-10-28.json","detectorKey":"identity-leak","error":"identity leak in docs/evidence/r2-to-gcs-storage-migration-2026-10-23/p004-checkpoint-before-provider-binding-2026-10-28.json — this names ONE developer's machine or person, is wrong on every other checkout, and ships to users inside the release source drop.\n\n1 hardcoded home path(s):\n    line 5 (user \"marsh-office\"): \"checkpoint\": \"…[older checkpoint content truncated]…\\nemain partial; all P002/P003/P004 acceptance remains op\nFIX by deriving the path, not by adding an exception:\n    node/ts   os.homedir()  ·  path relative to import.meta.url / __dirname\n    shell     \"$HOME\"  ·  git -C \"$(dirname \"$0\")\" rev-parse --show-toplevel\n    systemd   %h\n    config    a machine-local ~/.papercusp/*.env, read at run time","fixerRole":"content-fixer","contentHash":"1ef8c267f69a38ab4641db7626029be166c088ec8d5086687d622cf43b5d8c65","detectorResultHash":"9df8bf235a15812ad8760dbf8c7db44a7df13adb363915abcfe564b8d780942e"}]}

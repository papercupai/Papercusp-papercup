---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-retry-publication-fire26-424d5.json"
updated_at: 1791840157406
_body: "content"
---

{
  "schemaVersion": "r13-retry-publication-fire26-v1",
  "owner": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "resume": "coord-send-756dc0baec83c54e5f12c60a1be48cbd6228575c523a22e6e8ed70b4cba42237",
  "claims": "Six authoritative assignees self confirmed20:58Z",
  "loop": "active300sec/cold after timeout; no replay",
  "source": {
    "path": "apps/operator/scripts/hooks/cc/posttooluse-locks-release.sh",
    "sha256": "3c4192ffaa392bff066093d81fb2a0618d15741bc42a40bf452255198b8192ac",
    "committed": true,
    "installedPath": "/home/marsh-office/.papercusp/hooks/cc/posttooluse-locks-release.sh",
    "installedHashEqual": true
  },
  "test": {
    "path": "apps/operator/scripts/hooks/cc/__tests__/pretooluse-locks-decision.test.ts",
    "sha256": "9c75cec8333f3ee3d03eaece90a78847e4d433138b17480911fd198e07789234",
    "committed": true,
    "priorFullFileRun": 21155821
  },
  "installedProbe": {
    "log": "/tmp/parked-fire26-installed-retry-424d5.log",
    "exit": 0,
    "filter": "native retry consumes|PostToolUse releases through the same physical domain",
    "head": "39152ae9b0",
    "status": "passed",
    "skips": 46
  },
  "compactionContainment": {
    "routeProof": "/tmp/parked-fire26-compaction-runtime-424d5.json",
    "staging": "39152ae9b0",
    "background": "6d0afb5dd2",
    "containsChange": true,
    "behaviorProof": false
  },
  "remaining": [
    "Original failed-parent Post omission unverified; peer8402 not modified.",
    "No-host private behavior pending; do not repeat90 solely for recall.",
    "Frozen116 eligibility precedes18+7 joins.",
    "ALL-final-fix runtime anchor absent; no R14 date."
  ]
}

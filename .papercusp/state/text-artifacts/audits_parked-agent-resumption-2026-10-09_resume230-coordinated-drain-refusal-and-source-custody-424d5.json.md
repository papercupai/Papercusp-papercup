---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume230-coordinated-drain-refusal-and-source-custody-424d5.json"
updated_at: 1792765146109
_body: "content"
---

{
  "capturedAt": "2026-10-23T14:19:06.035071+00:00",
  "requestKey": "resume230-bg-adoption-424d5-20261023T1403",
  "restartOutcome": {
    "ok": false,
    "target": "bg-host",
    "reason": "git_sync_barrier_drain_timeout",
    "restarted": false,
    "drained": false,
    "resource": "git-sync",
    "holders": [
      {
        "owner": "system:git-sync:2519844:4919e585-b3f4-438b-baa5-87f88e3f47a3",
        "owner_label": "git-sync:papercusp",
        "mode": "shared",
        "status": "held"
      },
      {
        "owner": "system:git-sync:2519844:f3b1a02a-0bfe-43e4-b9c0-1a18daff81f7",
        "owner_label": "git-sync:papercusp-pr-drill-20261014",
        "mode": "shared",
        "status": "held"
      },
      {
        "owner": "system:git-sync:2519844:9bffc7c5-7b74-4597-b6d4-f2123d3a1023",
        "owner_label": "git-sync:portal",
        "mode": "shared",
        "status": "held"
      },
      {
        "owner": "system:git-sync:2519844:51eb2a0a-704f-4003-8367-f6a0012f6784",
        "owner_label": "git-sync:phone-app",
        "mode": "shared",
        "status": "held"
      },
      {
        "owner": "system:git-sync:2519844:a45743a8-52bd-4f32-89da-96b2cd622455",
        "owner_label": "git-sync:restart",
        "mode": "shared",
        "status": "held"
      },
      {
        "owner": "system:dev-restart:git-sync-barrier:4009993:f32ba0aa-0a69-4517-bb42-56394a61d878",
        "owner_label": "su · su-424d5",
        "mode": "exclusive",
        "status": "draining"
      }
    ],
    "note": "Restart REFUSED before draining — a git-sync operation holds the atomic git-sync barrier after the earlier cgroup preflight. No target users were drained; retry when that operation settles. The git-sync barrier did not clear within the requested 120s wait; check the live barrier before retrying."
  },
  "stderrPath": "/tmp/parked-resume230-bg-adoption-424d5.err",
  "head": "d9e349cba2a0ae86feaeaf7f39d3ae7959200d2d",
  "sourceCustody": [
    {
      "path": "packages/operator-core/lib/spec-conformance/conformance-test-content.ts",
      "workingSha256": "dcde420c389bc1e9c2f19756830ba444ef9e9b5ba7282e9b3124f4e65af816d3",
      "headBlobAvailable": true,
      "headSha256": "37640868b8e52db604e13ae7e19a5e20ef520cddfea1257f7d60538f60da6d6e",
      "matchesHead": false
    },
    {
      "path": "packages/operator-core/lib/spec-conformance/conformance-test-content.test.ts",
      "workingSha256": "e24076f7a27be8dfe499d7e0aa89adaa7d51ec01b932b5b4d13449566bd6116e",
      "headBlobAvailable": true,
      "headSha256": "b835dda9cda806755d5234970d7c06aae4b76f9b52f42d6d780a048976685509",
      "matchesHead": false
    },
    {
      "path": "packages/operator-core/lib/fleet/git-via-sidecar.ts",
      "workingSha256": "20270ae3ccd3937c8f38c33d237c81985fb373b83130e631e7c368cd59a0487f",
      "headBlobAvailable": true,
      "headSha256": "20270ae3ccd3937c8f38c33d237c81985fb373b83130e631e7c368cd59a0487f",
      "matchesHead": true
    },
    {
      "path": "packages/operator-core/lib/fleet/git-via-sidecar.test.ts",
      "workingSha256": "6dc1fac8da1838c1210aba1359c15ebe03e07e27bcd93c2542882a29d56e1c8a",
      "headBlobAvailable": true,
      "headSha256": "6dc1fac8da1838c1210aba1359c15ebe03e07e27bcd93c2542882a29d56e1c8a",
      "matchesHead": true
    }
  ],
  "originalTests": "No rerun; original combined19+9 test21825400/map3a992eb9 and10GitBatch21824351 retained",
  "runtimeProfile": "/home/marsh-office/.papercusp/loop-profiles/loop-saturation-1792764483811-pid2519844-p95_1329ms.cpuprofile",
  "loadedSourceEvidence": "bundle580761..580835 old direct execFile git3; canonical source uses nextForkSlot/execFileViaSidecar and runGitBatch"
}

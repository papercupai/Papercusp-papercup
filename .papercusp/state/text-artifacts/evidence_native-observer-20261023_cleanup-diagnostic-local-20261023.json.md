---
rel_path: "evidence/native-observer-20261023/cleanup-diagnostic-local-20261023.json"
updated_at: 1792752074050
_body: "content"
---

{
  "schemaVersion": 1,
  "taskId": "0mvktpiaw1swd9nfa7h",
  "qualification": "LOCAL_FILTERED_DIAGNOSTIC_NOT_ACCEPTANCE",
  "log": {
    "path": ".papercusp/scratch/bash-cd5efd99-d8f.log",
    "sha256": "a8f2d6399ebf364b162dd0678fc82471d22dc925decd8f27bb73590ec22d018d"
  },
  "fileResult": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=afe9d2e1ae uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-23T10:24:57.218Z childSubstituted=0 skippedTests=6",
  "cleanupRows": [
    {
      "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvktrwbczk8n4qq5nj.scope",
      "kernelTasks": null,
      "processCount": 0
    },
    {
      "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-sidecar.slice/pc-0mvkts7m9b95nx11595.scope",
      "kernelTasks": null,
      "processCount": 0
    },
    {
      "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-sidecar.slice/pc-0mvktum6ixnxpjuk3r3.scope",
      "kernelTasks": null,
      "processCount": 0
    }
  ],
  "nativeExit": "CLEANUP_DIAGNOSTIC_EXIT=0 SIGNAL=null",
  "pgCleanup": {
    "dataDir": "/tmp/pcv/papercusp-native-pg-4pmDUc",
    "dataDirAbsent": true
  },
  "interpretation": "Selected case passed with six unselected. Null kernelTasks and processCount zero do not attest directory absence: the helpers conflate absent with unreadable. Original full immutable post-close failure remains unresolved.",
  "correction": "Retracted claim that this diagnostic proved three directories absent. Earlier separate probe observed original paths absent later; not proof at failed assertion."
}

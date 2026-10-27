---
rel_path: "evidence/native-observer-20261023/bootstrap-fixed-afe9d2e1ae75-launch.json"
updated_at: 1792749995815
_body: "content"
---

{
  "schemaVersion": 1,
  "source": {
    "head": "afe9d2e1ae751fbbf6786356db53947f90548340",
    "paths": [
      {
        "path": "packages/operator-core/lib/systemd-scope.ts",
        "sha256": "4fdfcffb4109320108ca4f3230ac38518bbb65e63dfd368da2e6de185ca94caf",
        "matchesCommit": true
      },
      {
        "path": "packages/operator-core/lib/systemd-scope.test.ts",
        "sha256": "0dbdb25865877df3a3608b68f3af603d00be51dabd52b302ad8e4d0df0aa53ee",
        "matchesCommit": true
      },
      {
        "path": "packages/operator-core/lib/task-manager/managed-spawn.ts",
        "sha256": "5c9516cee6dcef4ae6e05fd3d42981f0f20ada3b0c3b2211a186f3081f8d94df",
        "matchesCommit": true
      },
      {
        "path": "packages/operator-core/lib/task-manager/managed-spawn-scope-probe.test.ts",
        "sha256": "1847ab1f3d2103bbcf19b2f1eae719312c58e0ff4bf065d7f41cb418a9f36055",
        "matchesCommit": true
      }
    ],
    "allMatch": true
  },
  "typecheck": {
    "taskId": "0mvkso80psiii8x1088",
    "result": "LINT_TSC_RESULT scope=files exit=0 status=clean",
    "scope": "four named edited paths only"
  },
  "nativeVerification": {
    "taskId": "0mvkt0cy81aularektk",
    "state": "running",
    "command": "RTK_DISABLED=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_TEST_RUN_WORKSPACE=papercusp-workspace PC_EXECUTED_SOURCE_MAP_WORKSPACE=papercusp-workspace PC_EXECUTED_SOURCE_MAP_OUT=/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/native-plan/fair-2026-10-21/worker-bootstrap-fixed-afe9d2e1ae75-20261023.json PAPERCUSP_FAIR_PROCESS_OBSERVER_REQUIRED=1 node --import tsx --input-type=module <<'NODE'\nimport { startDedicatedNativePg } from './libs/test-config/src/dedicated-native-pg.ts';\nimport { spawn } from 'node:child_process';\nimport { existsSync } from 'node:fs';\nconst ref = 'afe9d2e1ae751fbbf6786356db53947f90548340';\nconst pg = await startDedicatedNativePg({baseDir:'/tmp/pcv'});\nconsole.log('PRIVATE_PG_READY', JSON.stringify({dataDir:pg.dataDir,port:pg.port,lifecycle:'owned-per-run'}));\nlet code = 1;\ntry {\n const child = spawn('npm',['run','lint:as-committed','--','test:file','--ref='+ref,'--any','--','packages/operator-core/lib/systemd-scope.test.ts','packages/operator-core/lib/task-manager/managed-spawn-scope-probe.test.ts','packages/operator-core/lib/code-intelligence/fair-process-observer.test.ts','packages/operator-core/lib/code-intelligence/fair-comparison.integration.test.ts'],{stdio:'inherit',env:{...process.env,PAPERCUSP_TEST_PG_ADMIN_URL:pg.getConnectionUri()}});\n code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>{console.log('FULL_BOOTSTRAP_NATIVE_EXIT='+status+' SIGNAL='+signal);resolve(status??1);});});\n} finally {\n await pg.stop();\n const dataDirAbsent=!existsSync(pg.dataDir);\n console.log('PRIVATE_PG_STOPPED',JSON.stringify({dataDir:pg.dataDir,dataDirAbsent}));\n if(!dataDirAbsent) code=1;\n}\nprocess.exitCode=code;\nNODE",
    "capture": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/native-plan/fair-2026-10-21/worker-bootstrap-fixed-afe9d2e1ae75-20261023.json",
    "log": ".papercusp/scratch/bash-2ea87bda-196.log",
    "outcome": "unmeasured"
  },
  "loopRecovery": {
    "status": "enqueued-once; native-origin linkage unverified",
    "routineId": "rt_papercusp_loop_su_9ab8c7bf_12d5_412a_aefd_0ec60b3aa6bd"
  },
  "preserved": "Original01e83723 frozen questions/order/budgets, all acceptance residue, owner-only GitHub mirror wall"
}

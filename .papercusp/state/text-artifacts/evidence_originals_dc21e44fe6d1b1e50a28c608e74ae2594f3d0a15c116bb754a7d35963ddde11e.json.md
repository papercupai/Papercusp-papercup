---
rel_path: "evidence/originals/dc21e44fe6d1b1e50a28c608e74ae2594f3d0a15c116bb754a7d35963ddde11e.json"
updated_at: 1790936181224
_body: "content"
---

{
  "schemaVersion": 1,
  "incomplete": true,
  "plane": "serving-operator-http-preflight-private-cohorts",
  "bundleSha256": "98713d6efbf9a474fd5e3af3014383307ab5fdfa5bf7e5c54dfaf0ceefd650cf",
  "workerSha256": "fc4febf9df144a3a704fb29d5dd3dc6a7e4350bda29d17511bfcc0819187fb00",
  "sourceDirectory": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-41f842ced14e.iaO4JU/checkout/apps/operator/dist-host",
  "cohorts": [
    {
      "mode": "control",
      "samples": [
        {
          "phase": "preflight",
          "pid": 1338869,
          "at": 1790924248432,
          "uptime": 7.134042278,
          "memory": {
            "rss": 975192064,
            "heapTotal": 673222656,
            "heapUsed": 586845632,
            "external": 148299783,
            "arrayBuffers": 72024846
          },
          "heap": {
            "total_heap_size": 673222656,
            "total_heap_size_executable": 6193152,
            "total_physical_size": 673222656,
            "total_available_size": 137052506464,
            "used_heap_size": 586850520,
            "heap_size_limit": 137640280064,
            "malloced_memory": 4218952,
            "peak_malloced_memory": 118602888,
            "does_zap_garbage": 0,
            "number_of_native_contexts": 2,
            "number_of_detached_contexts": 0,
            "total_global_handles_size": 118872,
            "used_global_handles_size": 113952,
            "external_memory": 148299823,
            "total_allocated_bytes": 1801061672
          },
          "os": {
            "pid": 1338869,
            "parent": 1338792,
            "startTicks": "21392043",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKiB": 927602,
            "anonymousKiB": 922628,
            "privateDirtyKiB": 922672
          },
          "descendants": []
        }
      ],
      "requests": [
        {
          "window": 0,
          "value": {
            "ok": false,
            "runId": "bd3c1bfe-704a-42ca-b958-13b5482b2602",
            "root": "/home/marsh-office/papercupai-workspace/papercusp",
            "error": "route_error",
            "routerOutput": "TEST_FILE_ROUTE_ERROR requested test file does not exist: caller.test.ts; For the supported routed test surface, use testing:run { files: [...] }.\n",
            "testRunIds": [],
            "rootSource": "requested",
            "phaseTimingsMs": {
              "preflightMs": 10.94,
              "provenanceMs": 13.63,
              "preparationMs": 0.09,
              "admissionWaitMs": 35.94,
              "routerExecutionMs": 232.64,
              "ledgerIdReadbackMs": 2.24,
              "finalizationMs": 0.1,
              "totalHandlerMs": 559.05
            }
          },
          "requestSha256": "722209c73e2f8f2617f2b1c82d830c3c2c7772ac24067cad1e44b5388807b819",
          "requestBytes": 130
        }
      ],
      "descendants": [],
      "pauses": 0,
      "reaped": true,
      "identity": {
        "pid": 1338869,
        "entry": "/tmp/pcv/papercusp-serving-compiler-IT7YWL/host/hono-host.mjs",
        "startTicks": "21392043",
        "bundleSha256": "98713d6efbf9a474fd5e3af3014383307ab5fdfa5bf7e5c54dfaf0ceefd650cf"
      },
      "leaseReceipt": {
        "ok": true,
        "lock_id": "2dd67e45-d163-4f79-9c85-ae3c90e965e3",
        "owner": "loopback",
        "owner_label": "system · loopback",
        "expires_ts": "2026-10-02T06:59:28.406Z",
        "held": [
          "subject.txt"
        ],
        "newly_held": [
          "subject.txt"
        ],
        "sha_token": {
          "required_sha": null,
          "unsynced_risk": false
        }
      },
      "error": "Error: Expected real mutation refusal: {\"ok\":false,\"runId\":\"bd3c1bfe-704a-42ca-b958-13b5482b2602\",\"root\":\"/home/marsh-office/papercupai-workspace/papercusp\",\"error\":\"route_error\",\"routerOutput\":\"TEST_FILE_ROUTE_ERROR requested test file does not exist: caller.test.ts; For the supported routed test surface, use testing:run { files: [...] }.\\n\",\"testRunIds\":[],\"rootSource\":\"requested\",\"phaseTimingsMs\":{\"preflightMs\":10.94,\"provenanceMs\":13.63,\"preparationMs\":0.09,\"admissionWaitMs\":35.94,\"routerExecutionMs\":232.64,\"ledgerIdReadbackMs\":2.24,\"finalizationMs\":0.1,\"totalHandlerMs\":559.05}}",
      "hostErrorTail": "4, 1147, 1149, 1150, 1151, 1152, 1153, 1154, 1155, 1156, 1157, 1159, 1161, 1162, 1166, 1167, 1168, 1169, 1170, 1171, 1172, 1173, 1174, 1175, 1176, 1177, 1178, 1180, 1181, 1182, 1183, 1185, 1186, 1187, 1188, 1189, 1190, 1191, 1192, 1193, 1194, 1195, 1196, 1197, 1198, 1199, 1200, 1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208, 1209, 1210, 1211, 1212, 1213, 1214, 1215, 1216, 1217, 1218, 1219, 1220, 1221, 1223, 1224, 1225, 1226, 1227, 1228, 1229, 1230, 1231, 1232, 1233, 1234, 1235, 1236, 1237, 1238, 1239, 1240, 1241, 1242, 1243, 1244, 1245, 1246, 1247, 1248, 1249, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 1259, 1260, 1261, 1262, 1263, 1264, 1265, 1266, 1267, 1268, 1269, 1270, 1271, 1272, 1273, 1274, 1275, 1276, 1278, 1279, 1280, 1281, 1282, 1283, 1284, 1285, 1286, 1287, 1288, 1289, 1291, 1292, 1293, 1294, 1295, 1296, 1297, 1298, 1299, 1300, 1301, 1302, 1303, 1304, 1305, 1306, 1307, 1308, 1309, 1310, 1311, 1312, 1313, 1314, 1315, 1316, 1317, 1318, 1319, 1320, 1321, 1322, 1323, 1324, 1325, 1326, 1327, 1328, 1329, 1331, 1332, 1333, 1334, 1335, 1336, 1337, 1339) — lint:migrations check 5 would otherwise red the shared gate\n[hono-host] applied inbound server timeouts (ms): { keepAliveTimeout: 61000, headersTimeout: 65000 }\n[event-loop-sentinel] armed {\n  mode: 'kill',\n  wedgeAfterMs: 20000,\n  observationsToAct: 3,\n  startupGraceMs: 120000,\n  heartbeatIntervalMs: 1000,\n  observeIntervalMs: 2000\n}\n[hono-host] listening on http://127.0.0.1:37979 (pid=1338869)\n[hono-host] ⚠ PAPERCUSP_WORKSPACE_ID=test-runtime-8006b197-0a7 is set — this PINS workspace resolution to 'test-runtime-8006b197-0a7' for every non-request path on this multi-workspace host. Any window/tool that doesn't carry the x-papercusp-workspace header will see 'test-runtime-8006b197-0a7's harnesses/features/registry, regardless of the active workspace. Unset it unless this host is intentionally single-workspace.\n[hono-host] external-ingress listener on 127.0.0.1:32907 (no local trust)\nDebugger attached.\n",
      "leaseRelease": {
        "ok": true,
        "results": [
          {
            "ok": true,
            "lock_id": "2dd67e45-d163-4f79-9c85-ae3c90e965e3",
            "released": [
              "subject.txt"
            ],
            "cross_domain_released": [
              {
                "coordination_domain": "/tmp/pcv/papercusp-test-runtime-aqweND/workspaces/test-runtime-8006b197-0a7/operator-home",
                "released": [
                  "subject.txt"
                ]
              }
            ],
            "held_before": 1
          }
        ],
        "counts": {
          "ok": 1,
          "failed": 0
        }
      }
    }
  ],
  "limitations": [
    "Actual maintained HTTP testing:run preflight; private request-only processes and data, not ambient production load.",
    "Control uses an unsupported-extension mutation lease; compiler uses a code-module lease. HTTP request and source bytes match.",
    "Compiler workload is a refused mutation preflight, not a completed test run or normal idle baseline.",
    "No historical gigabyte caller attribution or production memory reduction is claimed.",
    "Executable PSS and V8 native counters are separate measurements, not a total native allocation estimate."
  ],
  "repositoryPreflight": {
    "root": "/tmp/pcv/papercusp-test-runtime-aqweND/workspaces/test-runtime-8006b197-0a7/operator-home",
    "initialized": true,
    "noCommit": true
  },
  "inputs": {
    "sourceBytes": 768915,
    "sourceSha256": "a0fba187b939a0fbaf9be5b48368a6d1a04a5e1ce1c69c261d958b7fb7f8d860",
    "testSha256": "e3d86a64cc2ea3839ac8327ea81fb2fc7ee746959465c022365db280b8386a89"
  },
  "error": "Error: Expected real mutation refusal: {\"ok\":false,\"runId\":\"bd3c1bfe-704a-42ca-b958-13b5482b2602\",\"root\":\"/home/marsh-office/papercupai-workspace/papercusp\",\"error\":\"route_error\",\"routerOutput\":\"TEST_FILE_ROUTE_ERROR requested test file does not exist: caller.test.ts; For the supported routed test surface, use testing:run { files: [...] }.\\n\",\"testRunIds\":[],\"rootSource\":\"requested\",\"phaseTimingsMs\":{\"preflightMs\":10.94,\"provenanceMs\":13.63,\"preparationMs\":0.09,\"admissionWaitMs\":35.94,\"routerExecutionMs\":232.64,\"ledgerIdReadbackMs\":2.24,\"finalizationMs\":0.1,\"totalHandlerMs\":559.05}}",
  "runner": {
    "status": 1,
    "signal": null,
    "stdoutBytes": 0,
    "stderrBytes": 4000,
    "log": {
      "path": "/tmp/su-7db4f-p011-serving-r22-child.log",
      "bytes": 622612,
      "sha256": "314ad88a94ddb931ca5f73a2b3ca550a57d056a3e4df48c1f0e0593e92e1992e"
    }
  }
}


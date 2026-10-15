---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold27-lineage-augmentation-guards-424d5.json"
updated_at: 1791898701613
_body: "content"
---

{
  "schemaVersion": "cold27-lineage-augmentation-guards-v1",
  "observedAt": "2026-10-13T13:38:11.638Z",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold26-original137-custody-assessment-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
  ],
  "parserSha256": "e10cb902f98e3df74a0d5be56d47f035ce3d3c83102c9b76becc8748fbd7931e",
  "augmentationSource": "function augment(t){const source=[...t.source.source_candidates,...t.lineage];const map=new Map();const signature=p=>JSON.stringify([p.session_id,p.part_idx,p.ts,p.part_kind,p.tool_name,p.text]);for(const p of source){for(const q of [p,...(p.following_parts||[])]){const key=q.session_id+\":\"+q.part_idx,old=map.get(key);if(old&&signature(old)!==signature(q))throw Error(\"conflicting original part \"+key);if(!old)map.set(key,q);}}const parts=[...map.values()].sort((a,b)=>a.session_id.localeCompare(b.session_id)||a.part_idx-b.part_idx);const candidates=parts.filter(p=>p.part_kind===\"tool_use\").map(p=>({...p,following_parts:parts.filter(q=>q.session_id===p.session_id&&q.part_idx===p.part_idx+1)}));return {...t,source:{...t.source,source_candidates:candidates},lineage:parts};}",
  "controls": [
    {
      "name": "exact original direct source supplied through lineage",
      "expected": true,
      "actual": true,
      "passed": true
    },
    {
      "name": "clipped original call",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "clipped original result",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "nonadjacent result",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "foreign native-session result",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "different owner",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "wrong ledger literal args",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "refused ledger with queued response",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "exact unoffered same-session wait source",
      "expected": true,
      "actual": true,
      "passed": true
    },
    {
      "name": "foreign-cell wait source",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "clipped waiting result",
      "expected": false,
      "actual": false,
      "passed": true
    },
    {
      "name": "clipped yield source",
      "expected": false,
      "actual": false,
      "passed": true
    }
  ],
  "executions": [
    {
      "label": "control:exact original direct source supplied through lineage",
      "inputSha256": "a102533bffc6d144032b8949d0d91cb43dca4473af4f1a0501d1aed84840c060",
      "inputBytes": 1177,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 700
    },
    {
      "label": "control:clipped original call",
      "inputSha256": "5db61c9d70bf0559ce23ba896d864a725b340d5a900775667d64cf6569017c35",
      "inputBytes": 1223,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":3,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 457
    },
    {
      "label": "control:clipped original result",
      "inputSha256": "16565eb763eccca49b2673ff7dd1f2e8182313a067dc32fe895cf52ac51290d0",
      "inputBytes": 1223,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 441
    },
    {
      "label": "control:nonadjacent result",
      "inputSha256": "18cf349590ae7422631b894f378cb1e00087fb8b7a1b5e8d631e5d2a1ef70b4e",
      "inputBytes": 998,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 402
    },
    {
      "label": "control:foreign native-session result",
      "inputSha256": "b2fb0a6963c5301a79e79283a3d01218a07c619f1eb50b155a9db09cdbe91666",
      "inputBytes": 981,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 383
    },
    {
      "label": "control:different owner",
      "inputSha256": "2f2ca221948003fa372d69ec37d440cbe1a144cdf16d8cd3e0c56c0573574c63",
      "inputBytes": 1168,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"foreign-owner\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":false,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 429
    },
    {
      "label": "control:wrong ledger literal args",
      "inputSha256": "eb31639ee04334470fbd74c0e85492ad50b5e230f92c99ef87423d51ed7a27ff",
      "inputBytes": 1168,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 480
    },
    {
      "label": "control:refused ledger with queued response",
      "inputSha256": "ad860cb670bd38b2b00a609369b069e9fb98deb40984c5e7c41159397439db7e",
      "inputBytes": 1182,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":false,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 445
    },
    {
      "label": "control:exact unoffered same-session wait source",
      "inputSha256": "f1216df3b12b09c3d114afba760b67958b001fea8b57c3c7db412b464e8e83e3",
      "inputBytes": 1917,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":13,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"abc\",\"links\":[{\"yieldPart\":11,\"waitPart\":12,\"precedingCallPart\":10}],\"waitPart\":12,\"originalCallPart\":10},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 463
    },
    {
      "label": "control:foreign-cell wait source",
      "inputSha256": "bb49c4c21831c4b47e53b032996b7e1e780462e48e8b90e6a77ed628ab741f08",
      "inputBytes": 1925,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 533
    },
    {
      "label": "control:clipped waiting result",
      "inputSha256": "69c1c30576e5ac80f2d0e472f02fc3c65e1f9659d10b63ba3b6350ca9bddbb35",
      "inputBytes": 1963,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":13,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"abc\",\"links\":[{\"yieldPart\":11,\"waitPart\":12,\"precedingCallPart\":10}],\"waitPart\":12,\"originalCallPart\":10},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 503
    },
    {
      "label": "control:clipped yield source",
      "inputSha256": "6a701cc3b486a77f4e7d1644cfda8d5383ce2b186e6c714acb5c3aee9749f657",
      "inputBytes": 1963,
      "stdout": "{\"rows\":[{\"request_id\":\"control\",\"owner\":\"analysis-control-owner\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"analysis-control-session\",\"callPart\":10,\"resultPart\":11,\"callTimestamp\":\"2026-10-01T00:00:00Z\",\"responseTimestamp\":\"2026-10-01T00:00:06Z\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": "",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 460
    }
  ],
  "summary": {
    "controlsPassed": 12,
    "controlsFailed": 0,
    "timeOuts": 0,
    "failedExecutions": 0
  }
}

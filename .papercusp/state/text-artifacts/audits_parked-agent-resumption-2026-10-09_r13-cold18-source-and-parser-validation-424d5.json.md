---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold18-source-and-parser-validation-424d5.json"
updated_at: 1791883968627
_body: "content"
---

{
  "schemaVersion": "cold18-original-receipt-validation-v1",
  "observedAt": "2026-10-13T09:31:49.805Z",
  "controls": [
    {
      "id": "34777625",
      "acceptedUnique": true,
      "receiptState": "flush-refused",
      "pairs": [
        {
          "nativeSession": "01a12170-b27a-7952-9a19-5139980985b3",
          "callPart": 201,
          "resultPart": 202,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 16:47:57.783+00",
          "durationMs": 673,
          "derivedDispatchStart": "2026-10-09T16:47:57.110Z",
          "callTimestamp": "2026-10-09T16:47:56.71+00:00",
          "responseTimestamp": "2026-10-09T16:47:58.472+00:00",
          "callBeforeDispatchMs": 400,
          "responseAfterSettleMs": 689,
          "bounds": true,
          "noAmbiguity": true,
          "format": "json",
          "textBlocks": 1,
          "body": {
            "ok": false,
            "requested": false,
            "error": "flush-required",
            "tripwires": [
              {
                "kind": "missing-checkpoint",
                "subject": "EI-25519734441837999",
                "detail": "EI-25519734441837999 has NO checkpoint written — its in-flight state will not carry."
              }
            ],
            "note": "Compaction is HELD: unflushed state would be lost across the boundary. Flush first, then retry:\n- write a checkpoint for EI-25519734441837999 — work_items:checkpoint { id, checkpoint } (no in-flight state survives without it)\nIf you retry WITHOUT flushing, the system will write a mechanical fallback checkpoint for you and proceed — but a checkpoint you write yourself carries far more than the mechanical one."
          },
          "state": "flush-refused",
          "statusAgrees": true,
          "accepted": true
        }
      ]
    },
    {
      "id": "34778962",
      "acceptedUnique": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a12170-b27a-7952-9a19-5139980985b3",
          "callPart": 223,
          "resultPart": 224,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 16:50:34.127+00",
          "durationMs": 6691,
          "derivedDispatchStart": "2026-10-09T16:50:27.436Z",
          "callTimestamp": "2026-10-09T16:50:26.627+00:00",
          "responseTimestamp": "2026-10-09T16:50:34.897+00:00",
          "callBeforeDispatchMs": 809,
          "responseAfterSettleMs": 770,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "none"
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ]
    }
  ],
  "archiveFileLookup": {
    "exactNativeSessions": [
      "01a110de-da18-77a1-ae59-266572a9581f",
      "01a1113e-65dd-7822-9033-cde625ea52e3",
      "01a11158-b6c7-7c23-8712-bc632b5004fa",
      "01a121d9-d398-73d1-9c88-63eb0cf9aec2",
      "01a121eb-3503-7542-b2aa-9e568eec1d49",
      "01a121fc-57f2-7932-b336-bb7206c0e5a8",
      "01a12212-c9fe-7921-bc00-6644cf505bab",
      "01a12228-9932-7040-a68b-192083ea9f40",
      "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
      "01a1224b-a4da-7813-8679-5959b1e641f6",
      "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
      "01a12266-3e63-7283-821f-8cbcd5c543fa",
      "01a12266-7409-79d3-9456-31ae1f03c7fb",
      "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
      "01a1228a-51bb-7100-b09e-114c38bf3712",
      "01a122a7-e41a-7f92-9cfc-a825eca90ad8",
      "01a122c3-b67b-7e12-a835-3aae3548eb00",
      "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
      "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
      "01a122ee-350a-77d0-b4b1-f2b553271268",
      "01a122fc-9a60-7772-8189-7fdc8cf876bb",
      "01a12308-16d4-7b32-8c56-c080e0f308f7",
      "01a12309-a334-7de2-ba2d-b2e49d793aaa",
      "01a12315-8b95-7243-8949-1b20acf248cd",
      "01a1231e-4587-78c2-aa03-27c4229be312",
      "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
      "01a12329-3110-7ed1-b8cd-0af91f5a7d90",
      "01a12329-777a-7b80-8fc3-ab01535f10ae",
      "01a12337-f502-7103-9a8a-d2d14c76be56",
      "01a12339-7862-78e3-b4af-30c8e8bbe6f7",
      "01a12344-1bcc-7313-bd5f-46510e73c99c",
      "01a12348-953f-7483-9589-e1a23948d6f5",
      "01a12366-709f-7563-883f-29a8b509fa28",
      "01a12367-db6e-7d32-b369-cb7e792a16e4",
      "01a12368-3a80-78b2-b196-a4b27f28a933",
      "01a122a5-50fd-75c1-b5a5-a75c3e496e63",
      "01a12386-af1f-7621-951a-227fee9b3df4",
      "01a123dd-2b69-75b2-8323-c43e797bca78",
      "01a123df-0540-7073-ab0f-160863c68c25",
      "01a123fe-6eda-7640-9dc5-7f91366ee84e",
      "01a12411-e413-7d30-ae42-79e0a4cd8440",
      "01a12489-abcc-7ff3-b35a-a8a84157896e",
      "01a124bf-7bab-7351-93bf-9daa6283b81e",
      "01a124df-4dc0-7741-97a6-73362938b29d",
      "01a124e2-3f90-7a21-911a-e231ad19ebf7",
      "01a124fe-a7f4-7400-82a0-711981ff4174",
      "01a1252d-875a-7600-b7c0-29f98f6791f2",
      "01a12531-ca04-75f2-a94c-e14631082377"
    ],
    "matchedFiles": [],
    "positiveControl": [
      {
        "session_id": "01a121c4-f814-7730-bdc2-8f0d9cf98ff4",
        "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "file_count": 1,
        "relpath": "sessions/2026/10/09/rollout-2026-10-09T13-45-19-01a121c4-f814-7730-bdc2-8f0d9cf98ff4.jsonl",
        "sha256": "00a18c19bb9ca7d08fb123ae35510c5433b951d9a8290d39eb54ad7649af91ad",
        "bytes_raw": 2546223
      }
    ]
  },
  "limits": [
    "Exact48 candidate native IDs only; no claim about every filesystem/archive location.",
    "Native file deletion actor and durable detector unknown; owned EI-25855583682954393.",
    "Queued receipts do not establish cutoff eligibility/model/account/carry or recovery."
  ],
  "sourceCollector": "import {getOrgPg} from \"@papercusp/db-org\";\nconst a=await Bun.file(\"/tmp/parked-cold18-assessment-424d5.json\").json();\nconst orig=await Bun.file(\"/tmp/parked-cold18-candidates-424d5.json\").json();\nconst unresolved=new Set(a.rows.filter(x=>!x.acceptedUnique).map(x=>x.request_id));\nconst ledger=a.ledger.filter(x=>unresolved.has(x.id));\nconst {sql}=getOrgPg();\nconst recovered=[];\nfor(const l of ledger){\n const settle=new Date(l.invoked_at).getTime(),start=settle-Number(l.duration_ms);\n const calls=await sql.unsafe(\"SELECT session_id,part_idx,ts,text,tool_name FROM harness_shared.session_turn_parts WHERE workspace_id=$1 AND owner=$2 AND part_kind=$3 AND ts >= $4::timestamptz AND ts <= $5::timestamptz ORDER BY ts LIMIT 12\",[\"default\",l.coord_owner_id,\"tool_use\",new Date(start-2000).toISOString(),new Date(settle+1000).toISOString()]);\n for(const c of calls)c.following_parts=await sql.unsafe(\"SELECT part_idx,ts,text,part_kind,tool_name FROM harness_shared.session_turn_parts WHERE workspace_id=$1 AND session_id=$2 AND part_idx>$3 AND part_idx<=$4 ORDER BY part_idx\",[\"default\",c.session_id,c.part_idx,c.part_idx+3]);\n recovered.push({owner:l.coord_owner_id,request_id:l.id,at:l.invoked_at,durationMs:l.duration_ms,derivedDispatchStart:new Date(start).toISOString(),ledger_status:l.status,source_candidates:calls});\n}\nconst sessions=[...new Set(recovered.flatMap(x=>x.source_candidates.map(c=>c.session_id)))];\nconst ingest=await sql.unsafe(\"SELECT source_kind,file_path,part_count FROM harness_shared.session_ingest_state WHERE source_kind=$1 AND file_path ILIKE ANY($2)\",[\"codex\",sessions.map(x=>\"%\"+x+\"%\")]);\nconst archives=await sql.unsafe(\"SELECT session_id,owner,adv_session_id,session_root,manifest FROM harness_shared.session_archives WHERE source_kind=$1 AND (session_id=ANY($2) OR owner=ANY($3))\",[\"codex\",sessions,[...new Set(ledger.map(x=>x.coord_owner_id))]]);\nconst out={schemaVersion:\"r13-cold18-derived-start-recovery-v1\",observedAt:new Date().toISOString(),cutoff:a.cutoff,cohortHash:a.cohortHash,sourceRef:\"r13-cold21-original137-receipt-assessment-cold17-v5-424d5.json\",matchingRule:\"unresolved89 only; corpus default; all tool_use native parts in [dispatchStart-2s,settle+1s]; following3parts; bounded12calls per request; candidate only\",rows:recovered,ingest,archives,processor:null};\nawait Bun.write(\"/tmp/parked-cold18-derived-start-recovery-424d5.json\",JSON.stringify(out,null,2));\nconsole.log(JSON.stringify({population:ledger.length,withCandidate:recovered.filter(x=>x.source_candidates.length).length,candidateNativeSessions:sessions.length,ingestRows:ingest.length,archiveRows:archives.length,capRows:recovered.filter(x=>x.source_candidates.length===12).map(x=>x.request_id)}));\nprocess.exit(0);",
  "assessmentWrapper": "const a=await Bun.file(\"/tmp/parked-cold18-assessment-424d5.json\").json();\nconst orig=await Bun.file(\"/tmp/parked-cold18-candidates-424d5.json\").json();\nconst rec=await Bun.file(\"/tmp/parked-cold18-derived-start-recovery-424d5.json\").json();\nconst unresolved=new Set(a.rows.filter(x=>!x.acceptedUnique).map(x=>x.request_id));\nconst by=new Map(orig.rows.map(x=>[x.request_id,x]));\nconst rows=rec.rows.map(x=>{const sources=new Map();for(const c of [...(by.get(x.request_id).source_candidates||[]),...x.source_candidates]){const k=c.session_id+\":\"+c.part_idx;const old=sources.get(k);if(!old||c.text.length>old.text.length)sources.set(k,c);}return {...x,source_candidates:[...sources.values()]};});\nconst input={artifact:{rows},ledger:a.ledger.filter(x=>unresolved.has(x.id))};\nconst processor=a.formatProcessor.replace('if(!x||typeof x!==\"object\")return;', 'if(typeof x===\"string\"){if(/^format: \\\\S+\\\\n/.test(x)||/^[\\\\[{\"]/.test(x.trim()))decodeBody(x,{path,textBlocks:null});return;} if(!x||typeof x!==\"object\")return; if(x.type===\"text\"&&typeof x.text===\"string\"){decodeBody(x.text,{path,textBlocks:null});return;}');\nconst cp=Bun.spawnSync([\"bun\",\"--eval\",processor],{cwd:process.cwd(),stdin:Buffer.from(JSON.stringify(input)),stdout:\"pipe\",stderr:\"pipe\"});\nif(cp.exitCode!==0)throw Error(cp.stderr.toString());\nconst parsed=JSON.parse(cp.stdout.toString()),marker=/… \\[truncated \\d+ chars\\]/;\nfor(const r of parsed.rows){const source=rows.find(x=>x.request_id===r.request_id);for(const pair of r.pairs){const c=source.source_candidates.find(x=>x.session_id===pair.nativeSession&&x.part_idx===pair.callPart),next=c.following_parts.find(x=>x.part_idx===pair.resultPart);pair.sourceComplete=!marker.test(c.text)&&!marker.test(next.text);if(!pair.sourceComplete)pair.accepted=false;}\n const accepted=r.pairs.filter(x=>x.accepted);r.acceptedUnique=accepted.length===1;r.receiptState=r.acceptedUnique?accepted[0].state:\"unresolved\";r.reason=accepted.length>1?\"multiple-accepted\":accepted.length===0?\"no-accepted-complete-pair\":null;}\nconst accepted=parsed.rows.filter(x=>x.acceptedUnique);\nconst out={schemaVersion:\"r13-cold18-unresolved89-reassessment-v2\",observedAt:new Date().toISOString(),cutoff:a.cutoff,cohortHash:a.cohortHash,sourceRefs:[\"r13-cold21-original137-receipt-assessment-cold17-v5-424d5.json\",\"r13-cold137-derived-start-recovery-cold18-424d5.json\"],acceptedCold17Immutable:a.rows.filter(x=>x.acceptedUnique),rows:parsed.rows,sources:rows,ledger:input.ledger,processor,summary:{population:137,priorImmutable:48,newCompletePairs:accepted.length,newQueued:accepted.filter(x=>x.receiptState===\"queued\").length,newFlushRefused:accepted.filter(x=>x.receiptState===\"flush-refused\").length,remainingUnresolved:89-accepted.length,outcomesJoined:0,cutoffContinuityAccepted:0},limits:a.limits};\nawait Bun.write(\"/tmp/parked-cold18-reassessment-424d5.json\",JSON.stringify(out,null,2));console.log(JSON.stringify({summary:out.summary,newIDs:accepted.map(x=>x.request_id),incomplete:parsed.rows.flatMap(x=>x.pairs.filter(p=>!p.sourceComplete).map(p=>x.request_id)),candidateNull:parsed.rows.filter(x=>x.candidates===0).length}));",
  "sourceArtifactReadback": {
    "chars": 234543,
    "sha256": "2f61f0643af100cbb4e305596b65a5f672034d3c9dd06f9cb52914275e0058c5"
  },
  "assessmentReadback": {
    "chars": 544860,
    "sha256": "eef0113901f7ed4bec9487c0604fab7ce5d21340daa54e83ffef3a8179fb9b69",
    "priorImmutable": 48,
    "newComplete": 10,
    "pairCollisions": [],
    "queued": 57,
    "flushRefused": 1,
    "unresolved": 79,
    "outcomesJoined": 0
  }
}

---
rel_path: "reports/admission-boundary/wi-16287-legacy-request-supplement-20261016-2231.json"
updated_at: 1792189889150
_body: "content"
---

{
  "schemaVersion": 1,
  "workItemId": "WI-6554700010016287",
  "sourceTranscript": "/home/marsh-office/.papercusp/su-codex-homes/session-36711/sessions/2026/10/16/rollout-2026-10-16T13-04-07-01a145ab-c509-78c0-b1ec-f4b23859f97d.jsonl",
  "requestAndReceipt": {
    "request": {
      "timestamp": "2026-10-16T17:13:56.088Z",
      "callId": "call_6f3bfab3983a481e8bbe2756450e0908",
      "source": "text(await tools.exec_command({cmd:\"python3 - <<'PY'\\nimport json,subprocess\\nfrom pathlib import Path\\nr=json.loads(Path('/tmp/wi-16287-legacy-park-results.json').read_text());a=json.loads(Path('/tmp/wi-16287-legacy-admitted.json').read_text());attempted={i for r in r['records'] for i in r['safe']};attempted.update(x['id'] for x in json.loads(Path('/tmp/wi-16287-legacy-park-first.json').read_text())['results']);ids=[i for i in a['admitted'] if i not in attempted]\\nscript='''const ids=IDS; const r=await tools.workItems.get({ids,harness:'papercusp',threadLimit:0}); const safe=[],skipped=[];\\nfor(const x of r.results){const w=x.workItem,p=w?.payload; const protectedRow=!p||p._claimHold||p.needsOwnerAction||p.needsHuman||p._claimLease||(p.externalBlockers?.length>0)||('planItemBlocked' in x);\\nif(x.ok&&w?.state==='open'&&!w.assignee&&!protectedRow&&String(p._bridge?.conditionKey??'').startsWith('alarm:')) safe.push(x.id); else skipped.push({id:x.id,state:w?.state,holder:w?.assignee,protected:!!protectedRow});}\\nconst result=safe.length?await tools.workItems.release({ids:safe,harness:'papercusp',claimHold:true,claimHoldRelease:{condition:'An item-specific review records a measured actionable unique root cause or an explicitly opted-in operational condition for this legacy alarm incident.',trigger:'plan:work-queue-exclusion-alarm-duplicates-2026-10-16:legacy-alarm-reconciliation-2026-10-16',owner:'su-055e916b-4218-4d93-9e0d-4a2c57fe9026'},reason:'D-002 legacy alarm reconciliation: preserve evidence; exclude unreviewed broad-alarm incidents pending actionability and canonical-uniqueness review.'}):null;\\nreturn JSON.stringify({safe,skipped,receipt:result?{ok:result.ok,counts:result.counts,held:result.results.filter(x=>x.ok&&x.claimHold).length,failures:result.results.filter(x=>!x.ok)}:null});'''.replace('IDS',json.dumps(ids))\\np=subprocess.run(['ptool','code:run','--url=http://localhost:3170','--workspace=papercusp-workspace','--harness=papercusp','--json','-'],input=json.dumps({'script':script,'timeoutSec':40,'title':'Park remaining qualified legacy alarm cohort'}),text=True,capture_output=True)\\nprint(p.returncode,p.stdout,p.stderr[-1800:] if p.returncode else '')\\nPY\",\"yield_time_ms\":30000,\"max_output_tokens\":1800}));\n"
    },
    "outcome": {
      "timestamp": "2026-10-16T17:14:23.506Z",
      "nativeExit": 0,
      "summary": {
        "safe": [
          "WI-6554700010016280",
          "WI-6554700010016281",
          "WI-6554700010016289",
          "WI-6554700010016290",
          "WI-6554700010016291",
          "WI-6554700010016292",
          "WI-6554700010016294",
          "WI-6554700010016301",
          "WI-6554700010016309",
          "WI-6554700010016310",
          "WI-6554700010016321",
          "WI-6554700010016323",
          "WI-6554700010016324",
          "WI-6554700010016325",
          "WI-6554700010016330",
          "WI-6554700010016334",
          "WI-6554700010016337",
          "WI-6554700010016339",
          "WI-6554700010016340",
          "WI-6554700010016341",
          "WI-6554700010016342",
          "WI-6554700010016343",
          "WI-6554700010016347"
        ],
        "skipped": [
          {
            "id": "WI-6554700010016346",
            "state": "done",
            "holder": null,
            "protected": false
          }
        ],
        "receipt": {
          "ok": true,
          "counts": {
            "ok": 23,
            "failed": 0
          },
          "held": 23,
          "failures": []
        }
      },
      "childFailures": [],
      "dispatchTimings": {
        "totalCount": 2,
        "omittedCount": 0,
        "calls": [
          {
            "ordinal": 0,
            "tool": "work_items:get",
            "effect": "read",
            "elapsedMs": 292,
            "disposition": "settled",
            "callId": "z5oxq2-3j"
          },
          {
            "ordinal": 1,
            "tool": "work_items:release",
            "effect": "write",
            "elapsedMs": 20973,
            "disposition": "settled",
            "callId": "z5oxq2-3l"
          }
        ],
        "maxCalls": 24
      }
    }
  },
  "links": [
    "reports/admission-boundary/wi-16287-legacy-baseline-20261016.json",
    "reports/admission-boundary/wi-16287-legacy-mutation-receipts-20261016.json",
    "reports/admission-boundary/wi-16287-legacy-current-20261016-2224.json"
  ],
  "limits": [
    "Historical evidence recovery only; no park operation replayed.",
    "Original request pre-reads each remaining ID and excludes existing holders, holds, leases, owner actions, blockers and non-open or non-alarm rows. No force argument.",
    "Offset70 in earlier manifest remains outcome-unknown reconciled by state; this23-ID write excludes those previously attempted IDs."
  ]
}

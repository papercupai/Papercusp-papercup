---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold40-original-disk-pipeline-source-custody-424d5.json"
updated_at: 1791950201558
_body: "content"
---

{
  "schemaVersion": "r13-cold40-original-disk-pipeline-source-custody-v1",
  "observedAt": "2026-10-14T03:56:40.460Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "subject": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
  "route": "Same approved SELF/AUTO/P013/account/cold",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "reads": {
    "earlyServingCalls": {
      "args": {
        "sql": "SELECT id,invoked_at,tool_name,status,serving_host,serving_build_sha,args_json FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND coord_owner_id='su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a' AND invoked_at>='2026-10-09T08:00:00Z' AND invoked_at<='2026-10-09T08:25:00Z' AND (tool_name IN ('dev:pipeline_position','routines:list','capability:bash')) ORDER BY invoked_at LIMIT 20",
        "allowUnscoped": false,
        "maxRows": 20,
        "timeoutMs": 10000
      },
      "result": {
        "advisory": "⚠ single-agent activity read: harness_shared.tool_invocations records MCP calls ONLY, so this window is NOT \"everything this agent did\" — native Claude Code Bash/Read/Grep/Edit produce no row at all, and this box's bypass-permissions preamble actively steers agents to native Bash for reads. Measured over ingested transcript parts (24h): native 54,009 calls across 183 agents vs MCP 35,479 across 128, so ~60% of recorded tool use is invisible here. The error is DIRECTIONAL — missing rows can only make an agent look LESS active, so a sparse or empty window reads as \"idle\" and escalates into waking, accusing or reassigning a peer who was working (EI-21847759967934033: this ledger showed one agent making only coord:glance / activity:report while it was in fact running Bash the whole time). THE RULE: positive rows prove activity; absence here proves nothing. To look for the missing half, start with `activity:tool-log { owner: '<the coord ownerId>' }` — it reads harness_shared.agent_activity, which DOES record native calls, and renders the command text. But do not invert the error onto it: that store is empty for ~45% of agents (24h: 182 of 333 tool_invocations owners had any rows), so an empty tool-log is equally not evidence of idleness. Corroborate with the transcript store, which is corpus-namespaced — workspace_id = 'default', NOT your tenant id: SELECT ts, tool_name, text FROM harness_shared.session_turn_parts WHERE workspace_id = 'default' AND owner = '<the coord ownerId>' AND ts > now() - interval '30 minutes' ORDER BY ts DESC LIMIT 50. `owner` is the coord ownerId and `text` is the faithful-render payload column, so both take the same id you scoped this query with. ⓘ a tool covers this read: activity:tool-log / dev:telemetry / dev:tool_cooccurrence — per-tool rollups (count, error rate, p50/p95) and the compact per-session call log. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.",
        "mode": "query",
        "rowCount": 9,
        "truncated": false,
        "fields": [
          "id",
          "invoked_at",
          "tool_name",
          "status",
          "serving_host",
          "serving_build_sha",
          "args_json"
        ],
        "elapsedMs": 373,
        "rows": [
          {
            "id": "34511241",
            "invoked_at": "2026-10-09 08:00:36.379+00",
            "tool_name": "dev:pipeline_position",
            "status": "ok",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "path": "packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts",
              "testClass": "operator-api"
            }
          },
          {
            "id": "34511782",
            "invoked_at": "2026-10-09 08:01:45.17+00",
            "tool_name": "dev:pipeline_position",
            "status": "ok",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "path": "packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts",
              "testClass": "operator-api"
            }
          },
          {
            "id": "34513633",
            "invoked_at": "2026-10-09 08:05:19.275+00",
            "tool_name": "routines:list",
            "status": "ok",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "name": "git-sync",
              "installSlug": "papercusp"
            }
          },
          {
            "id": "34516144",
            "invoked_at": "2026-10-09 08:10:26.796+00",
            "tool_name": "routines:list",
            "status": "ok",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "name": "git-sync",
              "installSlug": "papercusp"
            }
          },
          {
            "id": "34516205",
            "invoked_at": "2026-10-09 08:10:32.584+00",
            "tool_name": "dev:pipeline_position",
            "status": "ok",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "path": "packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts",
              "testClass": "operator-api"
            }
          },
          {
            "id": "34516620",
            "invoked_at": "2026-10-09 08:11:35.302+00",
            "tool_name": "routines:list",
            "status": "ok",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "name": "git-sync",
              "installSlug": "papercusp"
            }
          },
          {
            "id": "34516670",
            "invoked_at": "2026-10-09 08:11:40.176+00",
            "tool_name": "dev:pipeline_position",
            "status": "ok",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "path": "packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts",
              "testClass": "operator-api"
            }
          },
          {
            "id": "34517537",
            "invoked_at": "2026-10-09 08:13:34.518+00",
            "tool_name": "capability:bash",
            "status": "ok",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "command": "du -x -d1 /home/marsh-office 2>/dev/null | sort -n | tail -15",
              "timeout": 120000,
              "description": "Measure top-level disk usage",
              "yield_after_ms": 30000,
              "run_in_background": true
            }
          },
          {
            "id": "34518630",
            "invoked_at": "2026-10-09 08:15:32.646+00",
            "tool_name": "capability:bash",
            "status": "refused",
            "serving_host": "port-3271",
            "serving_build_sha": "cf57965610",
            "args_json": {
              "command": "du -x -d1 /home/marsh-office 2>/dev/null | sort -n | tail -15",
              "timeout": 120000,
              "description": "Measure top-level disk usage",
              "yield_after_ms": 30000,
              "run_in_background": true
            }
          }
        ]
      }
    },
    "retainedNativeBoundary": {
      "args": {
        "sql": "SELECT part_idx,ts,part_kind,tool_name,length(text) AS stored_chars,text FROM harness_shared.session_turn_parts WHERE workspace_id='default' AND source_kind='codex' AND session_id='01a11fa5-603e-7e21-b091-51a69f60fcac' AND owner='su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a' AND part_idx IN (125,126,135,136,138,140,141) ORDER BY part_idx",
        "allowUnscoped": false,
        "maxRows": 7,
        "timeoutMs": 10000
      },
      "result": {
        "mode": "query",
        "rowCount": 7,
        "truncated": false,
        "fields": [
          "part_idx",
          "ts",
          "part_kind",
          "tool_name",
          "stored_chars",
          "text"
        ],
        "elapsedMs": 103,
        "rows": [
          {
            "part_idx": 125,
            "ts": "2026-10-09 08:10:23.069+00",
            "part_kind": "tool_use",
            "tool_name": "exec",
            "stored_chars": 1028,
            "text": "const tasks = [\n  [\"position\", tools.mcp__papercusp_su__dev_pipeline_position({\n    path: \"packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts\",\n    testClass: \"operator-api\",\n    projection: { pick: [\"positions\", \"targetSha\", \"servingRuntimes\", \"currentBuildTestRoute\"] }\n  })],\n  [\"routine\", tools.mcp__papercusp_su__routines_list({ name: \"git-sync\", installSlug: \"papercusp\" })],\n  [\"disk\", tools.exec_command({\n    cmd: \"df -B1 --output=avail,size,pcent /home/marsh-office/papercupai-workspace/papercusp\",\n    workdir: \"/home/marsh-office/papercupai-workspace/papercusp\",\n    yield_time_ms: 10000,\n    max_output_tokens: 500\n  })]\n];\nconst out=await Promise.allSettled(tasks.map(async([label,p])=>[label,await p]));\nfor(const entry of out){\n if(entry.status!==\"fulfilled\"){text(JSON.stringify({error:String(entry.reason)}));continue;}\n const [label,value]=entry.value;\n const raw=value?.content?.find(x=>x.type===\"text\")?.text ?? JSON.stringify(value);\n text(JSON.stringify({label,raw:raw.slice(0,4500)}));\n}\n"
          },
          {
            "part_idx": 126,
            "ts": "2026-10-09 08:10:33.503+00",
            "part_kind": "tool_result",
            "tool_name": null,
            "stored_chars": 2024,
            "text": "Script completed\nWall time 10.4 seconds\nOutput:\n\n{\"label\":\"position\",\"raw\":\"⚠ the tool or its payload shaper marked field-level/custom-shaper truncation or partial-result metadata before this projection ($.content (inline) (…[truncated +504 chars]); $.gate.verdictStaleReason (inline) (…[truncated +504 chars]); $.gate.inconclusive.detail (inline) (…[truncated +306 chars]); $.gate.repairQueue.admissions[0].reason (inline) (…[truncated +148 chars]); $.gate.repairQueue.admissions[1].reason (inline) (…[truncated +38 chars]); $.gate.repairQueue.admissions[2].reason (inline) (…[truncated +10 chars]); $.gate.candidateFailures.nonTestLegs.perLeg[1].reading (inline) (…[truncated +1 chars]); $.gate.candidateFailures.nonTestLegs.shrink.scope (inline) (…[truncated +246 chars])). The projection can inspect only the retained subset/window — if the source is rank-ordered, this is the HEAD of a ranking, not a representative slice; any filter/count is a floor over that retained data and may be systematically skewed toward whatever the ordering favors. The pick may also have dropped the marker itself. omitted fields/items were never serialized, so any filter/count is not a complete population finding. re-call dev:pipeline_position with payloadTier:'full' (or narrower args) before concluding a value is absent.\\n[projection: pick positions,targetSha,servingRuntimes,currentBuildTestRoute → 65 of 65 lines, 1,931 of 31,000 chars (94% of the body removed)\\n⚠ pick applied to the JSON payload item; 1 advisory text item(s) (e.g. \\\"See also\\\" routing hints) were dropped — re-call without `pick` to keep them.]\"}\n{\"label\":\"routine\",\"raw\":\"{\\\"count\\\":1,\\\"routines\\\":[{\\\"_partial\\\":true,\\\"name\\\":\\\"git-sync\\\",\\\"installSlug\\\":\\\"papercusp\\\",\\\"triggerKind\\\":\\\"cron\\\",\\\"cron\\\":\\\"0 */3 * * * *\\\",\\\"targetRole\\\":\\\"system:git-sync\\\",\\\"active\\\":true,\\\"nextFireAt\\\":\\\"2026-10-09T08:12:00.000Z\\\",\\\"lastFiredAt\\\":\\\"2026-10-09T08:09:05.336Z\\\",\\\"group\\\":\\\"git-sync\\\",\\\"paused\\\":null,\\\"health\\\":{\\\"_partial\\\":true,\\\"las… [truncated 4480 chars]"
          },
          {
            "part_idx": 135,
            "ts": "2026-10-09 08:11:27.745+00",
            "part_kind": "tool_use",
            "tool_name": "exec",
            "stored_chars": 1320,
            "text": "const tasks = [\n  [\"test_ledger\", tools.mcp__papercusp_su__tools_invoke({\n    name: \"testing:runs\",\n    args: {\n      filePath: \"packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.test.ts\",\n      commitSha: \"e39f2baef4\",\n      source: \"local\",\n      harness: \"papercusp\",\n      since: \"2026-10-09T08:09:45.388Z\",\n      latestPerFile: false,\n      limit: 10\n    }\n  })],\n  [\"pipeline\", tools.mcp__papercusp_su__dev_pipeline_position({\n    path: \"packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts\",\n    testClass: \"operator-api\",\n    projection: { pick: [\"positions\", \"targetSha\", \"servingRuntimes\", \"currentBuildTestRoute\"] }\n  })],\n  [\"routine\", tools.mcp__papercusp_su__routines_list({ name: \"git-sync\", installSlug: \"papercusp\" })]\n];\nconst out=await Promise.allSettled(tasks.map(async([label,promise])=>[label,await promise]));\nfor(const entry of out){\n if(entry.status!==\"fulfilled\"){text(JSON.stringify({error:String(entry.reason)}));continue;}\n const [label,value]=entry.value;\n if(label===\"pipeline\"){\n   text(JSON.stringify({label,content:value?.content?.map(x=>x.text).filter(Boolean).map(t=>t.slice(0,2500))}));\n } else {\n   const raw=value?.content?.map(x=>x.text).filter(Boolean).join(\"\\n\") ?? JSON.stringify(value);\n   text(JSON.stringify({label,raw:raw.slice(0,5000)}));\n }\n}\n"
          },
          {
            "part_idx": 136,
            "ts": "2026-10-09 08:11:43.79+00",
            "part_kind": "tool_result",
            "tool_name": null,
            "stored_chars": 2025,
            "text": "Script completed\nWall time 16.0 seconds\nOutput:\n\n{\"label\":\"test_ledger\",\"raw\":\"{\\\"count\\\":1,\\\"total\\\":1,\\\"truncatedByLimit\\\":false,\\\"latestPerFile\\\":false,\\\"effectiveSourceFilter\\\":\\\"source = 'local' (explicit)\\\",\\\"omittedBySourceFilter\\\":0,\\\"runs\\\":[{\\\"id\\\":20952516,\\\"status\\\":\\\"pass\\\",\\\"workspaceId\\\":\\\"papercusp-workspace\\\",\\\"harnessSlug\\\":\\\"papercusp\\\",\\\"root\\\":\\\"/home/marsh-office/papercupai-workspace/papercusp\\\",\\\"executionDetails\\\":{\\\"root\\\":\\\"/home/marsh-office/papercupai-workspace/papercusp\\\",\\\"failed\\\":0,\\\"passed\\\":213,\\\"skipped\\\":0,\\\"filePath\\\":\\\"packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.test.ts\\\",\\\"commitSha\\\":\\\"e39f2baef4c200bf7df967f431d828ecd82d9892\\\",\\\"testLayer\\\":\\\"unit\\\",\\\"runGroupId\\\":null,\\\"harnessSlug\\\":\\\"papercusp\\\",\\\"workspaceId\\\":\\\"papercusp-workspace\\\",\\\"mutationPhase\\\":null,\\\"schemaVersion\\\":1,\\\"worktreeDirty\\\":true,\\\"testNamePattern\\\":null,\\\"collectionFailed\\\":false,\\\"passedCaseTitles\\\":[\\\"supersession preserves measured mutation provenance > allows a caught ledger-backed mutant to replace earlier proof\\\",\\\"supersession preserves measured mutation provenance > retains exact failed identities for an explicitly bounded filtered mutant\\\",\\\"supersession preserves measured mutation provenance > refuses binder success claims without measured mutation assertions\\\",\\\"supersession preserves measured mutation provenance > refuses an uncaught or non-assertion mutant {\\\\\\\"status\\\\\\\":\\\\\\\"pass\\\\\\\",\\\\\\\"passed\\\\\\\":1,\\\\\\\"failed\\\\\\\":0,\\\\\\\"collectionFailed\\\\\\\":false}\\\",\\\"supersession preserves measured mutation provenance > refuses an uncaught or non-assertion mutant {\\\\\\\"status\\\\\\\":\\\\\\\"fail\\\\\\\",\\\\\\\"passed\\\\\\\":0,\\\\\\\"failed\\\\\\\":1,\\\\\\\"collectionFailed\\\\\\\":true}\\\",\\\"supersession preserves measured mutation provenance > refuses an uncaught or non-assertion mutant {\\\\\\\"status\\\\\\\":\\\\\\\"fail\\\\\\\",\\\\\\\"passed\\\\\\\":0,\\\\\\\"failed\\\\\\\":0,\\\\\\\"collectionFailed\\\\\\\":false}\\\",\\\"supersession preserves measured mutation provenance > matches measured mutation ti… [truncated 12492 chars]"
          },
          {
            "part_idx": 138,
            "ts": "2026-10-09 08:12:34.653+00",
            "part_kind": "tool_result",
            "tool_name": null,
            "stored_chars": 2024,
            "text": "Script completed\nWall time 19.6 seconds\nOutput:\n\n[{\"tool\":\"work_items:checkpoint\",\"argSchema\":\"constraint:items[].retireIds (Requires effective `rowsMode:'replace'`; an `items[]` entry overrides the root setting, and omitted `rowsMode` defaults to `'merge'`.); constraint:retireIds (same as constraint:items[].retireIds); alias-group:insight|keyInsight; alias-group:next|nextAction|goal; alias-group:id|workItem; id?:string(≥1); checkpoint?:string|object|null; note?:string|null(≤32000); did?:string|null(≤32000); left?:string|null(≤32000); insight?:string|null(≤32000); next?:string|null(≤32000); keyInsight?:string|null(≤32000); nextAction?:string|null(≤32000); goal?:string|null(≤32000); workItem?:string(1-120); clear?:boolean; confirmClear?:boolean; items?:array(1-100){checks?:array(≤12){id?:string(≤160),replaces?:string(≤4000),claim:string(1-2000 (soft cap ≤500)),sinceMs?:number,recheck?:string(≤1200 (soft cap ≤300)),falsifier?:string(≤1200 (soft cap ≤300)),sampleAdequate?:boolean,verified?:string(≤1200 (soft cap ≤300)),observed?:string(≤1200 (soft cap ≤300)),testResult?:string(≤1200 (soft cap ≤300)),…+10},…+19}; harness?:string(≤80); append?:boolean; confirmShrink?:boolean; rowsMode?:enum(replace|merge); confirmRetire?:boolean; retireIds?:array(≤24)<string>; checks?:array(≤12){id?:string(≤160),replaces?:string(≤4000),claim:string(1-2000 (soft cap ≤500)),sinceMs?:number,recheck?:string(≤1200 (soft cap ≤300)),falsifier?:string(≤1200 (soft cap ≤300)),sampleAdequate?:boolean,verified?:string(≤1200 (soft cap ≤300)),observed?:string(≤1200 (soft cap ≤300)),testResult?:string(≤1200 (soft cap ≤300)),…+10}; dependsOn?:array(≤24)<string>; learned?:string(≤4000); learnedLevel?:enum(work_item|plan|goal); unchanged?:boolean single shorthand default for `unchanged`; also the items[] default. ATTEST that the stored checkpoint is still current instead of rewriting it. Requires `contentHash`. Do not send `checkpoint`, `did`/`left`/`insight`/`next`, `clear`, `appe…; contentHash?:string(6… [truncated 2068 chars]"
          },
          {
            "part_idx": 140,
            "ts": "2026-10-09 08:13:00.828+00",
            "part_kind": "tool_result",
            "tool_name": null,
            "stored_chars": 208,
            "text": "Script completed\nWall time 0.0 seconds\nOutput:\n\n[{\"name\":\"mcp__papercusp_su__code_run\",\"callable\":\"function\",\"listed\":true},{\"name\":\"mcp__papercusp_su__capability_bash\",\"callable\":\"undefined\",\"listed\":false}]"
          },
          {
            "part_idx": 141,
            "ts": "2026-10-09 08:13:29.453+00",
            "part_kind": "tool_use",
            "tool_name": "exec",
            "stored_chars": 694,
            "text": "const r = await tools.mcp__papercusp_su__code_run({\n  title: \"summarize filesystem usage\",\n  description: \"Measure top-level usage under the operator home to identify safe disk remediation candidates.\",\n  timeoutSec: 45,\n  script: \"const r = await tools.capability.bash({command:\\\"du -x -d1 /home/marsh-office 2>/dev/null | sort -n | tail -15\\\",timeout:120000,yield_after_ms:30000,run_in_background:true,description:\\\"Measure top-level disk usage\\\"}); const t = r?.content?.find(x=>x.type===\\\"text\\\")?.text ?? \\\"\\\"; let p={}; try { p=JSON.parse(t); } catch {} return {ok:p.ok,status:p.status,bash_id:p.bash_id,task_id:p.task_id,running:p.running,output:p.output};\"\n});\ntext(JSON.stringify(r));\n"
          }
        ]
      }
    }
  },
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold36-original-budget-whole-work-source-witness-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold39-dependency-scope-and-expanded-controls-424d5.json"
  ],
  "historicalSource": {
    "build": "cf57965610",
    "origin": "serving_build_sha of exact dated MCP invocations, not present-day runtime",
    "gitFetchHeadroom": {
      "path": "packages/operator-core/lib/harness/git-sync/git-fetch-headroom.ts",
      "blob": "cc8483545bb3b141f0b8caa606849d31c8bd8b20",
      "verifiedRead": "git show cf57965610:<path>; resolves actual git object-store path; samples freeBytes; refuses fetch/pull when freeBytes<=criticalWriteHeadroomBytes; non-fetch calls run directly"
    },
    "diskAlarm": {
      "path": "packages/operator-core/lib/storage/disk-space-alarm.ts",
      "blob": "40aee9ad3952e313f6936837005458a2371823a8",
      "verifiedRead": "git show cf57965610:<path>; statfs bavail*bsize gives freeBytes and blocks*bsize gives totalBytes; reserve=max(absolute,min(proportional,cap))"
    },
    "boundary": "Serving build pins the MCP evaluator/pipeline-reader source for these exact calls. It does not by itself pin the separate git-sync runner loaded source or the code loaded through the later cutoff."
  },
  "assessment": {
    "earlyDiskBlock": "Source-supported checkpoint with fetch-specific historical guard; not independently full-native-output verified",
    "retainedNativeResults": "Indexed results contain explicit truncation markers. Complete indexed bytes are not necessarily complete original result bytes.",
    "pipelineCallCustody": "Positive dated MCP rows prove exact pipeline requests on cf57965610; status ok is not containsChange or acceptance success.",
    "independentReachableSteps": "Original command125 requests read-only disk/routine/pipeline rechecks in parallel; original checkpoint plans same rechecks. These reads do not invoke fetch, so the fetch-specific guard does not itself block them. Applicability and actual progress at final cutoff remain unverified.",
    "cutoffEligibility": "review-open",
    "remaining": [
      "Resource/disk/pipeline change custody from original review01:09:46.552Z through final cutoff16:00:36.515Z",
      "Immutable original fuller native outputs or explicit source-coverage residue",
      "Historical dependency mutation evidence, resolved-recipient/broadcast controls, loaded loop source continuity",
      "Freeze original116 eligibility before joining recovery outcomes"
    ]
  },
  "summary": {
    "originalPopulation": 116,
    "membershipUnchanged": true,
    "preservedAcceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0,
    "newAcquisitions": 0,
    "productTestsRerun": 0
  }
}

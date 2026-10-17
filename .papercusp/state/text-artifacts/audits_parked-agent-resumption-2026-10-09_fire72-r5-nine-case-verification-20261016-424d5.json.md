---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire72-r5-nine-case-verification-20261016-424d5.json"
updated_at: 1792116175939
_body: "content"
---

{
  "schemaVersion": 1,
  "edition": "Fire72 2026-10-16",
  "workItem": "WI-6554700010015360",
  "sourceBefore": {
    "head": "c6f75c726c9a3a7ec3fb9bab2fc429390cbf07ac",
    "hashes": {
      "apps/operator/scripts/psu-pty-host.mjs": "b768786456f4eb19e87aef55b6eedd640f9d8da25344b2b54a540a67692d0217",
      "apps/operator/lib/psu-pty-host-turn.integration.test.ts": "702da19b9de569bb67682b87f7060475c4e6993f6e409398930de083f7c8fc4a",
      "scripts/with-test-pg.mjs": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898",
      "libs/test-config/src/pg-container.ts": "ff38661efefaf125cecb3cbc2724d6281c221680bf57644963ad31d792c7eef2",
      "libs/test-config/src/admin-test-runs-reporter.ts": "e26eaa4c86d966849217796bd6850037e6670cfb1710379e7e637e75d9ad370b"
    },
    "expectedCases": 9,
    "pattern": "requires startup proof, preserves owner input|gates .* carry before submission"
  },
  "sourceAfter": {
    "head": "c6f75c726c9a3a7ec3fb9bab2fc429390cbf07ac",
    "hashes": {
      "apps/operator/scripts/psu-pty-host.mjs": "b768786456f4eb19e87aef55b6eedd640f9d8da25344b2b54a540a67692d0217",
      "apps/operator/lib/psu-pty-host-turn.integration.test.ts": "702da19b9de569bb67682b87f7060475c4e6993f6e409398930de083f7c8fc4a",
      "scripts/with-test-pg.mjs": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898",
      "libs/test-config/src/pg-container.ts": "ff38661efefaf125cecb3cbc2724d6281c221680bf57644963ad31d792c7eef2",
      "libs/test-config/src/admin-test-runs-reporter.ts": "e26eaa4c86d966849217796bd6850037e6670cfb1710379e7e637e75d9ad370b"
    },
    "sourceUnchanged": true,
    "childStatus": 0,
    "childSignal": null,
    "error": null
  },
  "committedGuard": {
    "head": "c6f75c726c9a3a7ec3fb9bab2fc429390cbf07ac",
    "paths": [
      "apps/operator/scripts/psu-pty-host.mjs",
      "apps/operator/lib/psu-pty-host-turn.integration.test.ts"
    ]
  },
  "command": "node --input-type=module <<'JS'\nimport {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {execFileSync,spawnSync} from 'node:child_process';import postgres from 'postgres';import {resolveScriptPgUrl} from './scripts/lib/pg-url.mjs';\nconst base={...process.env};const route=resolveScriptPgUrl({env:base});const sink=base.PAPERCUSP_TEST_RUNS_DB_URL?.trim()||route.url?.trim();if(!sink)throw new Error('REPORTER_PREFLIGHT_MISSING_SINK');const db=postgres(sink,{max:1,connect_timeout:5});try{const rows=await db`SELECT EXISTS(SELECT 1 FROM harness_shared.test_runs WHERE id=21263027 AND workspace_id='papercusp-workspace' AND harness_slug='papercusp') AS ledger`;if(!rows[0]?.ledger)throw new Error('REPORTER_PREFLIGHT_WRONG_LEDGER');}finally{await db.end({timeout:2})}\nconst paths=['apps/operator/scripts/psu-pty-host.mjs','apps/operator/lib/psu-pty-host-turn.integration.test.ts','scripts/with-test-pg.mjs','libs/test-config/src/pg-container.ts','libs/test-config/src/admin-test-runs-reporter.ts'];const hashes=()=>Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));const before=hashes();const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();for(const p of paths.slice(0,2)){const committed=createHash('sha256').update(execFileSync('git',['show',head+':'+p])).digest('hex');if(before[p]!==committed)throw new Error('R5_UNCOMMITTED_SOURCE:'+p);}console.log('R5_COMMITTED_GUARD '+JSON.stringify({head,paths:paths.slice(0,2)}));console.log('R5_SOURCE_BEFORE '+JSON.stringify({head,hashes:before,expectedCases:9,pattern:'requires startup proof, preserves owner input|gates .* carry before submission'}));\nconst result=spawnSync(process.execPath,['scripts/with-test-pg.mjs','--','npm','run','test:file','--','apps/operator/lib/psu-pty-host-turn.integration.test.ts','-t','requires startup proof, preserves owner input|gates .* carry before submission'],{stdio:'inherit',env:{...base,TMPDIR:'/dev/shm/pcv',PAPERCUSP_TEST_RUNS_DB_URL:sink,PAPERCUSP_TEST_RUN_WORKSPACE:'papercusp-workspace',PAPERCUSP_TEST_RUN_HARNESS:'papercusp',PAPERCUSP_TEST_RUN_RECEIPT_FILE:'/tmp/parked-fire72-r5-reporter-424d5.jsonl'}});const after=hashes();const sourceUnchanged=JSON.stringify(before)===JSON.stringify(after);console.log('R5_SOURCE_AFTER '+JSON.stringify({head,hashes:after,sourceUnchanged,childStatus:result.status,childSignal:result.signal,error:result.error?.code||null}));process.exit(result.status===0&&sourceUnchanged?0:result.status||2);\nJS",
  "taskId": "0mvabith21q6us671pd",
  "bashId": "119aa225-5bf",
  "logPath": ".papercusp/scratch/bash-119aa225-5bf.log",
  "logSha256": "0b6bb479e983dee3954a2f402431f9370b237833b2dda6084ecb18dc88e097ef",
  "terminalLines": [
    "[capability:bash] JOB END: status=completed exit=0 at 2026-10-16T01:58:42.431Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.",
    "[capability:bash] JOB END: status=completed exit=0 at 2026-10-16T01:58:42.639Z — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has been durably recorded yet: the job may still be running, or it may have died before its close handler wrote JOB END. Check capability:bash_output/task ledger; recovery writes JOB DIED after a ledger-confirmed unobserved death."
  ],
  "reporterPath": "/tmp/parked-fire72-r5-reporter-424d5.jsonl",
  "reporterReceipts": [
    {
      "receiptId": "51d1e340-9f80-4cc9-b354-b2e657038c49",
      "attempt": 0,
      "filePath": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
      "status": "pass",
      "row": {
        "filePath": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
        "status": "pass",
        "durationMs": 9925,
        "startedAt": "2026-10-16T01:58:31.002Z",
        "finishedAt": "2026-10-16T01:58:40.927Z",
        "outputTail": null,
        "isScratchConfig": false,
        "executionDetails": {
          "schemaVersion": 1,
          "runStartedAt": "2026-10-16T01:58:16.244Z",
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "runGroupId": null,
          "workspaceId": "papercusp-workspace",
          "harnessSlug": "papercusp",
          "testNamePattern": "requires startup proof, preserves owner input|gates .* carry before submission",
          "testLayer": "integration",
          "mutationPhase": null,
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured",
          "filePath": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
          "passed": 9,
          "failed": 0,
          "skipped": 58,
          "collectionFailed": false,
          "passedCaseTitles": [
            "Codex carry first turn on a continuously repainting fresh composer > ready: requires startup proof, preserves owner input, and records actual submission",
            "Codex carry first turn on a continuously repainting fresh composer > launch-ready: requires startup proof, preserves owner input, and records actual submission",
            "Codex carry first turn on a continuously repainting fresh composer > terminal-reply: requires startup proof, preserves owner input, and records actual submission",
            "Codex carry first turn on a continuously repainting fresh composer > owner-input: requires startup proof, preserves owner input, and records actual submission",
            "Codex carry first turn on a continuously repainting fresh composer > not-ready: requires startup proof, preserves owner input, and records actual submission",
            "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates adopted carry before submission, then proves delivery (confirmation true)",
            "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates adopted carry before submission, then proves delivery (confirmation false)",
            "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates in-place carry before submission, then proves delivery (confirmation true)",
            "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates in-place carry before submission, then proves delivery (confirmation false)"
          ],
          "worktreeDirty": true,
          "commitSha": "c6f75c726c9a3a7ec3fb9bab2fc429390cbf07ac",
          "worktreeDirtyReason": "51 porcelain line(s) before the run: M apps/operator/app/_components/ChromeShell.test.tsx |  M apps/operator/app/_components/ChromeShell.tsx |  M apps/operator/lib/release/green-checkpoint-legs-verdict-coverage.test.ts |  M apps/operator/lib/release/green-checkpoint-repair-tick-legs.test.ts |  M apps/operator/lib/release/green-checkpoint.ts",
          "runtimeEnvironmentAfterCaptureStatus": "not-configured"
        },
        "verifierSourceReason": null,
        "cases": [
          {
            "caseIndex": 0,
            "caseKey": "keeps a repainting tagged wake pending until native submission: retry",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 1,
            "caseKey": "keeps a repainting tagged wake pending until native submission: late-native",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 2,
            "caseKey": "keeps a repainting tagged wake pending until native submission: rearmed-late-native",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 3,
            "caseKey": "keeps a repainting tagged wake pending until native submission: replaced",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 4,
            "caseKey": "keeps a repainting tagged wake pending until native submission: replaced-after-reconcile",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 5,
            "caseKey": "keeps a repainting tagged wake pending until native submission: rearmed-replaced",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 6,
            "caseKey": "preserves the classified Codex home failure when refusing carry before stopping the child",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 7,
            "caseKey": "defers an already-admitted wake before writing when carry becomes pending",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 8,
            "caseKey": "defers an admitted wake at gate-wait when a carry arrives before the native boundary",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 9,
            "caseKey": "defers an admitted wake at re-arm when a carry arrives before the native boundary",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 10,
            "caseKey": "re-armed wake uses its verified native boundary without a second busy-gate wait",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 11,
            "caseKey": "classifies an interactive Codex capacity wall without retrying or hiding the PTY output",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 12,
            "caseKey": "Codex carry first turn on a continuously repainting fresh composer > ready: requires startup proof, preserves owner input, and records actual submission",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 407,
            "errorTail": null
          },
          {
            "caseIndex": 13,
            "caseKey": "Codex carry first turn on a continuously repainting fresh composer > launch-ready: requires startup proof, preserves owner input, and records actual submission",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 313,
            "errorTail": null
          },
          {
            "caseIndex": 14,
            "caseKey": "Codex carry first turn on a continuously repainting fresh composer > terminal-reply: requires startup proof, preserves owner input, and records actual submission",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 364,
            "errorTail": null
          },
          {
            "caseIndex": 15,
            "caseKey": "Codex carry first turn on a continuously repainting fresh composer > owner-input: requires startup proof, preserves owner input, and records actual submission",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 174,
            "errorTail": null
          },
          {
            "caseIndex": 16,
            "caseKey": "Codex carry first turn on a continuously repainting fresh composer > not-ready: requires startup proof, preserves owner input, and records actual submission",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2497,
            "errorTail": null
          },
          {
            "caseIndex": 17,
            "caseKey": "refreshes a pending Codex carry-respawn from a same-delivery retry before the re-arm commits (EI-24915900486106554)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 18,
            "caseKey": "owner input cannot cancel a late Codex native binding (WI-10007230) > reattaches the adopted successor even when owner input drops its carry",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 19,
            "caseKey": "owner input cannot cancel a late Codex native binding (WI-10007230) > reattaches the in-place successor even when owner input drops its carry",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 20,
            "caseKey": "Codex native id discovered after carry binding deadline (EI-25344556501316035) > gates a later wake on successor reanchor (confirmed true)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 21,
            "caseKey": "Codex native id discovered after carry binding deadline (EI-25344556501316035) > gates a later wake on successor reanchor (confirmed false)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 22,
            "caseKey": "Codex recycle reanchors its fresh native session before carry delivery > waits for the exact successor mapping before submitting the recycle carry",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 23,
            "caseKey": "unbound Codex successor is replaced or refused, never stranded (P-005 / D-003) > replaces a carry successor that never exposes its native id within the spawn-anchored window",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 24,
            "caseKey": "unbound Codex successor is replaced or refused, never stranded (P-005 / D-003) > refuses wakes to a still-unbound child as a durable deferral, then self-heals once it binds",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 25,
            "caseKey": "unbound Codex successor is replaced or refused, never stranded (P-005 / D-003) > refuses a PENDING retry once the child crosses the unbound window, and keeps the completed answer: continuous",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 26,
            "caseKey": "unbound Codex successor is replaced or refused, never stranded (P-005 / D-003) > refuses a PENDING retry once the child crosses the unbound window, and keeps the completed answer: repaint-gap",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 27,
            "caseKey": "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates adopted carry before submission, then proves delivery (confirmation true)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 927,
            "errorTail": null
          },
          {
            "caseIndex": 28,
            "caseKey": "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates adopted carry before submission, then proves delivery (confirmation false)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2067,
            "errorTail": null
          },
          {
            "caseIndex": 29,
            "caseKey": "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates in-place carry before submission, then proves delivery (confirmation true)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1046,
            "errorTail": null
          },
          {
            "caseIndex": 30,
            "caseKey": "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates in-place carry before submission, then proves delivery (confirmation false)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2121,
            "errorTail": null
          },
          {
            "caseIndex": 31,
            "caseKey": "waits for a headless Codex model-menu repaint before confirming the existing model",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 32,
            "caseKey": "leaves a later Codex model menu to the agent after a turn was submitted",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 33,
            "caseKey": "records a sanitized Codex provider and endpoint after a successful PTY spawn",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 34,
            "caseKey": "records initial submit plus each resubmit as attempts on a verified turn",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 35,
            "caseKey": "quota wall during launch kickoff preserves the host and publishes recovery through discovery",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 36,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (repaired)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 37,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (unavailable)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 38,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (wrong-route)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 39,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (auth)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 40,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (interactive)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 41,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (interactive-replay)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 42,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (owner-edit)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 43,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (automatic)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 44,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (automatic-transient)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 45,
            "caseKey": "Codex quota recovery verifies its auto route before replacing the child (automatic-unavailable)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 46,
            "caseKey": "psu-pty-host mode:turn CR-submit via the real discovery handshake (C2) > Codex idle repaint with a settled native turn uses only a verified completion boundary",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 47,
            "caseKey": "psu-pty-host mode:turn CR-submit via the real discovery handshake (C2) > Codex idle repaint with a active native turn uses only a verified completion boundary",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 48,
            "caseKey": "psu-pty-host mode:turn CR-submit via the real discovery handshake (C2) > Codex idle repaint with a predecessor-settled native turn uses only a verified completion boundary",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 49,
            "caseKey": "psu-pty-host mode:turn CR-submit via the real discovery handshake (C2) > discovers the live host by ownerId, injects a turn, and the child reads it as a SUBMITTED line",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 50,
            "caseKey": "psu-pty-host mode:turn CR-submit via the real discovery handshake (C2) > WI-1378748: an unconfirmed wake submit is bounded and recorded, but never kills the live session",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 51,
            "caseKey": "psu-pty-host delivery-id dedup: a retry of an ALREADY-DELIVERED wake never double-injects (EI-19311270129974785) > the SAME deliveryId injected twice (second arriving after the first already landed) produces exactly ONE echoed turn",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 52,
            "caseKey": "psu-pty-host delivery-id dedup: a retry of an ALREADY-DELIVERED wake never double-injects (EI-19311270129974785) > a SAME deliveryId retry refreshes the pending loop text before the busy gate opens, then still injects exactly once (EI-21428742689578243)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 53,
            "caseKey": "psu-pty-host delivery-id dedup: a retry of an ALREADY-DELIVERED wake never double-injects (EI-19311270129974785) > keeps a folded delivery ID retryable when its parent waiter defers at the busy cap (F03)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 54,
            "caseKey": "psu-pty-host delivery-id dedup: a retry of an ALREADY-DELIVERED wake never double-injects (EI-19311270129974785) > keeps a same delivery ID pending until a busy-gate turn re-arm settles",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 55,
            "caseKey": "psu-pty-host delivery-id dedup: a retry of an ALREADY-DELIVERED wake never double-injects (EI-19311270129974785) > a DIFFERENT deliveryId with the SAME text is a genuinely new delivery — not deduped",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 56,
            "caseKey": "psu-pty-host idle gate defers a turn while busy, submits once idle (C2 / P-013) > a turn injected during a keystroke burst does NOT land until typing stops + the idle window elapses",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 57,
            "caseKey": "psu-pty-host owner composer gate (EI-20199370837439455) > never appends a loop-fire envelope to a quiet, unsubmitted owner line",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 58,
            "caseKey": "psu-pty-host mid-turn inject safety: a turn DEFERS until the agent is at its prompt (coord-wake-mid-turn-2026-06-30) > a wake turn injected while the agent is MID-TURN (emitting) does NOT land until output goes quiet (back at prompt)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 59,
            "caseKey": "psu-pty-host mid-turn inject safety: a turn DEFERS until the agent is at its prompt (coord-wake-mid-turn-2026-06-30) > same-source turns stacked while the agent is busy COALESCE into ONE annotated delivery (compaction-continuity P-001a)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 60,
            "caseKey": "psu-pty-host mid-turn inject safety: a turn DEFERS until the agent is at its prompt (coord-wake-mid-turn-2026-06-30) > an agent that stays busy past the cap DROPS the live inject (never wedges the turn) — the durable inbox stands",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 61,
            "caseKey": "psu-pty-host clean-boundary-only kill (WI-1818, D-006): reset/recycle refuse mid-turn > a RECYCLE injected while the agent is MID-TURN does NOT kill the child until it settles — no boot++ while busy",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 62,
            "caseKey": "psu-pty-host clean-boundary-only kill (WI-1818, D-006): reset/recycle refuse mid-turn > a RESET injected while the agent is MID-TURN does NOT clear the context until it settles",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 63,
            "caseKey": "psu-pty-host cross-agent socket isolation (C1 / EI-153 class) > a turn addressed to A can never reach B: distinct sockets, inject touches only A",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 64,
            "caseKey": "psu-pty-host dead-host discovery rejection (self-validating) > findLiveHost returns null once the host has exited (socket gone / pid dead)",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 65,
            "caseKey": "psu-pty-host turn SUBMITS because the CR is a SEPARATE keystroke (paste-detector regression) > a paste-aware child (models the Claude Code TUI) receives a SUBMITTED turn — the pre-fix one-shot text+CR burst would NOT have submitted",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseIndex": 66,
            "caseKey": "owner keystrokes during submit verification (WI-10001508) > retries the prompt once the keyboard settles instead of dropping it",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          }
        ],
        "worktreeDirty": true,
        "commitSha": "c6f75c726c9a3a7ec3fb9bab2fc429390cbf07ac",
        "receiptId": "51d1e340-9f80-4cc9-b354-b2e657038c49",
        "receiptAttempt": 0
      },
      "outcome": "inserted",
      "id": "21267810"
    }
  ],
  "verification": {
    "ledger": {
      "id": "21267810",
      "file_path": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
      "status": "pass",
      "commit_sha": "c6f75c726c9a3a7ec3fb9bab2fc429390cbf07ac",
      "worktree_dirty": true,
      "passed": 9,
      "failed": 0,
      "skipped": 58,
      "passed_cases": [
        "Codex carry first turn on a continuously repainting fresh composer > ready: requires startup proof, preserves owner input, and records actual submission",
        "Codex carry first turn on a continuously repainting fresh composer > launch-ready: requires startup proof, preserves owner input, and records actual submission",
        "Codex carry first turn on a continuously repainting fresh composer > terminal-reply: requires startup proof, preserves owner input, and records actual submission",
        "Codex carry first turn on a continuously repainting fresh composer > owner-input: requires startup proof, preserves owner input, and records actual submission",
        "Codex carry first turn on a continuously repainting fresh composer > not-ready: requires startup proof, preserves owner input, and records actual submission",
        "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates adopted carry before submission, then proves delivery (confirmation true)",
        "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates adopted carry before submission, then proves delivery (confirmation false)",
        "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates in-place carry before submission, then proves delivery (confirmation true)",
        "host-code-adopted carry with a late Codex native id (EI-24961854655864836) > gates in-place carry before submission, then proves delivery (confirmation false)"
      ]
    },
    "privatePgPort": 35533,
    "privatePgPortClosed": true
  },
  "verificationLog": ".papercusp/scratch/bash-906d3262-f5b.log",
  "sourceDiff": "diff --git a/apps/operator/lib/psu-pty-host-turn.integration.test.ts b/apps/operator/lib/psu-pty-host-turn.integration.test.ts\nindex a350b49552..7990cf9732 100644\n--- a/apps/operator/lib/psu-pty-host-turn.integration.test.ts\n+++ b/apps/operator/lib/psu-pty-host-turn.integration.test.ts\n@@ -602,7 +602,11 @@ describe('Codex carry first turn on a continuously repainting fresh composer', (\n           // scenario asserts the proof requirement, not scheduler timing.\n           PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: scenario === 'not-ready' ? '600' : '60',\n           PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '250',\n-          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: '650',\n+          // Initial launch starts its clock before Node boots; the other\n+          // scenarios inject only after OLD-READY. Budget that bootstrap\n+          // separately from the 650ms delivery window for this fixture.\n+          PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS: scenario === 'launch-ready'\n+            ? String(CHILD_START_OUTPUT_TIMEOUT_MS + 650) : '650',\n           PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS: '10',\n           PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS: '200',\n           PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10',\ndiff --git a/apps/operator/scripts/psu-pty-host.mjs b/apps/operator/scripts/psu-pty-host.mjs\nindex cd38769452..8e612274b1 100644\n--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -2342,7 +2342,10 @@ export function carryTurnProofRequiresNativeId(agent) {\n  * deadlock: catalog discovery can complete while the host waits forever for an\n  * id that only the kickoff can mint. Fresh Codex still gets the stronger native\n  * transcript proof after submission; resumed/carry threads retain the binding\n- * gate because they already have an authoritative native identity. */\n+ * gate because they already have an authoritative native identity.\n+ * @param {{ agent?: string | null, isResume?: boolean, hasResolver?: boolean }} [options]\n+ *   Typed explicitly: inferred from `= {}` the declaration dropped `agent`, so every\n+ *   caller passing it was a TS2353. */\n export function launchKickoffRequiresPreSubmissionNativeBinding({\n   agent, isResume = false, hasResolver = false,\n } = {}) {\n@@ -12387,11 +12390,12 @@ export function hostThroughPty(o) {\n         maxRetries: codexLaunchStartingRetryMax(env.PAPERCUSP_PSU_PTY_CODEX_LAUNCH_STARTING_RETRIES),\n       };\n       let freshChildRetries = 0;\n+      let kickoffChild = child;\n       const injectLaunchKickoff = () => {\n         // Keep proof and preparation tied to the child that this kickoff\n         // submitted to. A same-host respawn can replace the mutable `child`\n         // binding while the native proof is still settling.\n-        const kickoffChild = child;\n+        kickoffChild = child;\n         launchKickoffAttemptStartedAtMs = Date.now();\n         launchKickoffAttemptBudgetMs = kickoffBudgetMs;\n         // WI-10007230: owner input can cancel carry before its prewrite hook.\n@@ -12633,6 +12637,10 @@ export function hostThroughPty(o) {\n               agent: env.PAPERCUSP_AGENT,\n               nativeId: proofNativeId,\n               proof,\n+              // An adopted carry already bound this exact child before its\n+              // first write. Reuse that confirmation after transcript proof.\n+              alreadyReported: confirmedCarryChild === kickoffChild &&\n+                confirmedCarryNativeId === proofNativeId,\n               report: onRespawn,\n               emit: () => {},\n               timeoutMs: respawnReportTimeoutMs,\n",
  "scope": "Committed repaired host+fixture source verified by two-path HEAD guard; five working-source hashes unchanged. Overall tree has peer edits: ledger worktreeDirty=true. Nine selected maintained cases passed, 58 filtered. This is not whole-suite, installed runtime, final shipment, or >=24h R14 acceptance. Original21264335 failing proof remains historical."
}

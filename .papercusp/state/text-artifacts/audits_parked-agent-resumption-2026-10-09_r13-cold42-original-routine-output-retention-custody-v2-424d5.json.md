---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold42-original-routine-output-retention-custody-v2-424d5.json"
updated_at: 1791952917651
_body: "content"
---

{
  "schemaVersion": "r13-cold42-original-routine-output-retention-custody-v2",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "capturedAt": "2026-10-14T04:36:02.760Z",
  "route": "Same approved SELF/AUTO/P013/account/cold",
  "sourceArtifact": "audits/parked-agent-resumption-2026-10-09/r13-cold41-resource-writer-and-interval-disk-custody-424d5.json",
  "subject": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
  "reviewAt": "2026-10-10T01:09:46.552Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "calls": [
    {
      "id": "34513633",
      "invoked_at": "2026-10-09 08:05:19.275+00",
      "tool_name": "routines:list",
      "output_ref": "papercusp://scratch/papercusp-workspace/routines:list/f7166e6b-2d95-4f8b-ac0e-29a0d055253a/result-door-1791533119276.md",
      "output_size": "7200",
      "status": "ok",
      "readObservation": {
        "method": "Authenticated capability:read exact uri byte_offset0 byte_limit1024; independently maintained ptool scratchUriToPath+readFile exact path",
        "status": "unavailable",
        "reason": "read_failed",
        "errno": "ENOENT",
        "observedAt": null,
        "source": "Current Cold42 tool blocks, exact three URI results returned individually in one code:run; no retries after absence"
      },
      "originalOutputAbsenceProven": false
    },
    {
      "id": "34516144",
      "invoked_at": "2026-10-09 08:10:26.796+00",
      "tool_name": "routines:list",
      "output_ref": "papercusp://scratch/papercusp-workspace/routines:list/8720c128-aced-46f1-b05b-a0de417891d7/result-door-1791533426797.md",
      "output_size": "7202",
      "status": "ok",
      "readObservation": {
        "method": "Authenticated capability:read exact uri byte_offset0 byte_limit1024; independently maintained ptool scratchUriToPath+readFile exact path",
        "status": "unavailable",
        "reason": "read_failed",
        "errno": "ENOENT",
        "observedAt": null,
        "source": "Current Cold42 tool blocks, exact three URI results returned individually in one code:run; no retries after absence"
      },
      "originalOutputAbsenceProven": false
    },
    {
      "id": "34516620",
      "invoked_at": "2026-10-09 08:11:35.302+00",
      "tool_name": "routines:list",
      "output_ref": "papercusp://scratch/papercusp-workspace/routines:list/5be017a7-daa7-4297-990a-c8036af6df78/result-door-1791533495303.md",
      "output_size": "7200",
      "status": "ok",
      "readObservation": {
        "method": "Authenticated capability:read exact uri byte_offset0 byte_limit1024; independently maintained ptool scratchUriToPath+readFile exact path",
        "status": "unavailable",
        "reason": "read_failed",
        "errno": "ENOENT",
        "observedAt": null,
        "source": "Current Cold42 tool blocks, exact three URI results returned individually in one code:run; no retries after absence"
      },
      "originalOutputAbsenceProven": false
    }
  ],
  "immutableSources": [
    {
      "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
      "path": "packages/operator-core/lib/scratch-gc.ts",
      "blob": "5a2195ff4ba69947f8a7dc728985a29362d03321",
      "sha256": "c983afdc4ef92899b7dfc6e209c5a8c7a52e40a7dfa8f982295d1aaae637cb22",
      "bytes": 39807,
      "snippets": [
        {
          "line": 52,
          "text": "\n/** Retention window for run-dirs since last mtime. 24h default. */\nexport const RETENTION_MS = 24 * 60 * 60 * 1000;\n\n/** Per-workspace quota. 5 GB default. */\nexport const WORKSPACE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;"
        },
        {
          "line": 70,
          "text": " * report retention as unenforced when the GC was working.\n */\nexport const SCRATCH_GC_CRONTAB = '0 0 3 * * *';\n\n/** Interval between sweeps implied by SCRATCH_GC_CRONTAB (daily). */\nexport const SCRATCH_GC_SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000;"
        },
        {
          "line": 327,
          "text": "      if (now - run.mtimeMs > RETENTION_MS) {\n        const bytes = await sizeOfDirAsync(run.dir);\n        await rmAsync(run.dir, { recursive: true, force: true });\n        summary.retentionEvictions += 1;\n        summary.retentionEvictedBytes += bytes;\n      }"
        },
        {
          "line": 496,
          "text": "      const deletionStartedAt = performance.now();\n      try {\n        await rmAsync(run.dir, { recursive: true, force: true });\n      } finally {\n        if (diagnostics) diagnostics.deletionMs += Math.max(0, performance.now() - deletionStartedAt);\n      }"
        }
      ]
    },
    {
      "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
      "path": "packages/operator-core/lib/dbos/periodic-workflows.ts",
      "blob": "2c85879e88d0384dcbd889186bea19b9ec4326f0",
      "sha256": "4bf0f40508673d36caedcf9f76f3843c5bbe05ed2c596fa1f2454ec7c4a94b1e",
      "bytes": 119639,
      "snippets": [
        {
          "line": 131,
          "text": "    async () => {\n      const workspaceRegistry = readRegistry().workspaces.map((w) => w.id);\n      const s = await runScratchGc({ workspaceRegistry });\n      // WI-10006512: what the sweep deleted, what it deliberately kept, and how much unowned\n      // top-level scratch exists, so a surprising deletion (or growth) is visible in the log.\n      console.log("
        },
        {
          "line": 166,
          "text": "  }),\n);\nDBOS.registerScheduled(scratchGcWorkflow, { name: 'scratchGc', crontab: SCRATCH_GC_CRONTAB });\n\n// (The 6-hourly mem0 ephemeral-TTL sweep was removed — the `ephemeral` kind is\n// retired, so nothing carries expires_at; ephemeral state lives in coord now."
        }
      ]
    },
    {
      "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
      "path": "packages/operator-core/lib/scratch-uri.ts",
      "blob": "d932d0a2c7e865d8b8e4f7c5b7cba9a7ab5b430a",
      "sha256": "b798770c143c62ad4db329322bd53a4f6988241da55d6dc15b0ab7a6537548ed",
      "bytes": 6949,
      "snippets": [
        {
          "line": 161,
          "text": " *\n * Default: `~/.papercusp/scratch`. Overridable via the\n * `PAPERCUSP_SCRATCH_ROOT` env var, which is the only seam tests use\n * (Linux's `os.homedir()` reads `/etc/passwd` not `$HOME`, so an\n * env-var swap can't redirect homedir-derived paths).\n */"
        },
        {
          "line": 165,
          "text": " * env-var swap can't redirect homedir-derived paths).\n */\nexport function scratchRoot(): string {\n  const override = process.env.PAPERCUSP_SCRATCH_ROOT;\n  if (override && override.trim().length > 0) return override.trim();\n  return join(homedir(), '.papercusp', 'scratch');"
        },
        {
          "line": 166,
          "text": " */\nexport function scratchRoot(): string {\n  const override = process.env.PAPERCUSP_SCRATCH_ROOT;\n  if (override && override.trim().length > 0) return override.trim();\n  return join(homedir(), '.papercusp', 'scratch');\n}"
        }
      ]
    }
  ],
  "assessment": {
    "routineOutputCustody": "Full original routine payloads unavailable at these exact live spill paths; recorded original output_ref/status alone does not prove full retained bytes or original output absence.",
    "retentionPolicy": "Immutable source pin cf57965610 documents24h run-dir retention and daily scratchGc; present absence is consistent with ephemeral retention but no per-path deletion receipt or historical loaded sweep proof was established.",
    "historicalLoadedSource": "Initial serving cf57965610 was pinned for original nine MCP calls by Cold40; original routine/source custody is separate from historical deletion-writer runtime custody.",
    "resourceDependencyContinuity": "Still unverified. Present leases are destructively expired/released; current rows do not establish historical absence.",
    "eligibility": "review-open; no outcome joins"
  },
  "ownedResidue": "EI-25927909729992864",
  "peerCorrection": {
    "item": "EI-25879329310017617",
    "post": 1179898,
    "author": "su-def821c4-3ab5-42e6-8c8b-c8379b210381",
    "createdAt": "2026-10-14T04:01:54.967Z",
    "summary": "Peer retracted prior claim that backup78714 was still queued; records failure by orphan sweep03:15:49Z. Retake78719 PG-dump timeout belongs EI-25164396022471391, separate from frozen sudo-wrapper acquisition class. No snapshot/acquisition work re-run."
  },
  "summary": {
    "originalPopulation": 116,
    "preservedAcceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0,
    "newAcquisitions": 0,
    "productTestsRerun": 0
  },
  "actions": {
    "newAcquisitions": 0,
    "productTestsRerun": 0,
    "sourceEdits": 0,
    "terminalRedos": 0,
    "routeChanges": 0,
    "accountChanges": 0,
    "liveGateOps": 0
  },
  "remaining": [
    "Resolve historical whole-work/control/dependency/loaded-source custody for review-open cutoff candidates",
    "Freeze original116 continuity/eligibility before outcomes",
    "Retain original113 accepted receipts and24 unresolved receipts without replays"
  ],
  "supersedesEvidence": "audits/parked-agent-resumption-2026-10-09/r13-cold42-original-routine-output-retention-custody-424d5.json",
  "timeCustodyCorrection": "The v1 readObservation.observedAt values were an agent-entered approximation, not a measured tool timestamp. Retracted as exact read times. The original Cold42 tool blocks establish the dated read; capturedAt records artifact persistence, not deletion or precise read time."
}

---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-literal-user-control-candidates-provenance-424d5.json"
updated_at: 1791993093391
_body: "content"
---

{
  "schemaVersion": "r13-cold53-seven-literal-user-control-candidates-v1",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceIndex": "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-lineage-user-source-index-424d5.json",
  "selection": "Machine prefix/head filter; exact refs and full text retained for remaining candidates. No attribution from speaker alone.",
  "sql": "WITH refs(source_kind,session_id,part_idx) AS (VALUES ('claude','01e06c2d-38f3-4242-855b-e3e26072becb',0),('claude','796a87ee-47f9-43f2-83f6-3720b50dfaff',250),('claude','43b6c1d6-0b55-42b4-8dd7-b87bbea87577',138),('claude','43b6c1d6-0b55-42b4-8dd7-b87bbea87577',140),('claude','129794b4-7f56-4591-b793-76986181727f',0),('claude','129794b4-7f56-4591-b793-76986181727f',35),('claude','129794b4-7f56-4591-b793-76986181727f',143),('claude','129794b4-7f56-4591-b793-76986181727f',157),('claude','129794b4-7f56-4591-b793-76986181727f',158),('claude','129794b4-7f56-4591-b793-76986181727f',156),('claude','129794b4-7f56-4591-b793-76986181727f',159),('claude','cf785121-4de4-450b-969b-7abed3cf1402',273),('claude','b293b5d8-c324-4c34-80e3-ca949b8a8dbb',58),('claude','b293b5d8-c324-4c34-80e3-ca949b8a8dbb',61),('claude','b293b5d8-c324-4c34-80e3-ca949b8a8dbb',62),('claude','b293b5d8-c324-4c34-80e3-ca949b8a8dbb',71),('claude','b293b5d8-c324-4c34-80e3-ca949b8a8dbb',72),('codex','01a0f6a1-9bdd-7142-88e4-12f088a4def7',2),('codex','01a0f6a1-9bdd-7142-88e4-12f088a4def7',27),('codex','01a0f6a9-2333-7dd3-a4a9-3434afa55b5b',49),('codex','01a0f6a9-2333-7dd3-a4a9-3434afa55b5b',68),('codex','01a0f6a9-2333-7dd3-a4a9-3434afa55b5b',69),('codex','01a0f6a9-2333-7dd3-a4a9-3434afa55b5b',112),('codex','01a0f754-26bd-7f73-874f-3b491a334ea3',116)) SELECT p.owner,p.source_kind,p.session_id,p.part_idx,p.ts,p.text,t.turn_idx,t.turn_origin,t.turn_origin_verdict FROM refs r JOIN harness_shared.session_turn_parts p ON p.workspace_id='default' AND p.source_kind=r.source_kind AND p.session_id=r.session_id AND p.part_idx=r.part_idx LEFT JOIN harness_shared.session_turns t ON t.workspace_id='default' AND t.source_kind=p.source_kind AND t.session_id=p.session_id AND t.speaker='user' AND t.ts=p.ts AND t.text=p.text ORDER BY p.owner,p.ts,p.session_id,p.part_idx LIMIT 200",
  "result": {
    "mode": "query",
    "rowCount": 24,
    "truncated": false,
    "fields": [
      "owner",
      "source_kind",
      "session_id",
      "part_idx",
      "ts",
      "text",
      "turn_idx",
      "turn_origin",
      "turn_origin_verdict"
    ],
    "elapsedMs": 62,
    "rows": [
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "01e06c2d-38f3-4242-855b-e3e26072becb",
        "part_idx": 0,
        "ts": "2026-10-06 03:27:54.285+00",
        "text": "put yourself on auto mode and carry the blueprint-backed-work-item-execution-2026-09-23 plan to shipped status yourself now",
        "turn_idx": 0,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "796a87ee-47f9-43f2-83f6-3720b50dfaff",
        "part_idx": 250,
        "ts": "2026-10-06 21:00:06.326+00",
        "text": " why did you stop?",
        "turn_idx": null,
        "turn_origin": null,
        "turn_origin_verdict": null
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "43b6c1d6-0b55-42b4-8dd7-b87bbea87577",
        "part_idx": 138,
        "ts": "2026-10-06 23:56:09.254+00",
        "text": "[Request interrupted by user]",
        "turn_idx": 15,
        "turn_origin": null,
        "turn_origin_verdict": "machine-surface"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "43b6c1d6-0b55-42b4-8dd7-b87bbea87577",
        "part_idx": 140,
        "ts": "2026-10-06 23:56:09.429+00",
        "text": "[Request interrupted by user]",
        "turn_idx": 17,
        "turn_origin": null,
        "turn_origin_verdict": "machine-surface"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "129794b4-7f56-4591-b793-76986181727f",
        "part_idx": 0,
        "ts": "2026-10-06 19:35:44.835+00",
        "text": "what's the status on getting main green?  Why is it taking so long?",
        "turn_idx": 0,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "129794b4-7f56-4591-b793-76986181727f",
        "part_idx": 35,
        "ts": "2026-10-06 19:43:35.572+00",
        "text": "How can we make this process faster?",
        "turn_idx": 3,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "129794b4-7f56-4591-b793-76986181727f",
        "part_idx": 143,
        "ts": "2026-10-06 20:52:24.932+00",
        "text": "Okay, write this all into a plan and show me a detailed summary",
        "turn_idx": 13,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "129794b4-7f56-4591-b793-76986181727f",
        "part_idx": 157,
        "ts": "2026-10-06 21:02:13.374+00",
        "text": "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>",
        "turn_idx": null,
        "turn_origin": null,
        "turn_origin_verdict": null
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "129794b4-7f56-4591-b793-76986181727f",
        "part_idx": 158,
        "ts": "2026-10-06 21:02:13.374+00",
        "text": "<local-command-stdout>Set model to `Opus 5.5` for this session only · couldn't confirm it was saved as your default (~/.papercusp/session-claude/su-3077f62c-1a5d-4be6-896c-e75866032dcb/settings.json is still being written)</local-command-stdout>",
        "turn_idx": null,
        "turn_origin": null,
        "turn_origin_verdict": null
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "129794b4-7f56-4591-b793-76986181727f",
        "part_idx": 156,
        "ts": "2026-10-06 21:02:13.375+00",
        "text": "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>",
        "turn_idx": null,
        "turn_origin": null,
        "turn_origin_verdict": null
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "129794b4-7f56-4591-b793-76986181727f",
        "part_idx": 159,
        "ts": "2026-10-06 21:02:23.926+00",
        "text": "okay put yourself on auto mode carry the plan to shipped status",
        "turn_idx": 17,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "cf785121-4de4-450b-969b-7abed3cf1402",
        "part_idx": 273,
        "ts": "2026-10-06 23:23:41.214+00",
        "text": "any other improbements to make based on this?",
        "turn_idx": 28,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "b293b5d8-c324-4c34-80e3-ca949b8a8dbb",
        "part_idx": 58,
        "ts": "2026-10-06 23:50:34.429+00",
        "text": "[Request interrupted by user]",
        "turn_idx": 5,
        "turn_origin": null,
        "turn_origin_verdict": "machine-surface"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "b293b5d8-c324-4c34-80e3-ca949b8a8dbb",
        "part_idx": 61,
        "ts": "2026-10-06 23:50:46.344+00",
        "text": "countinue where you left off",
        "turn_idx": 8,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "b293b5d8-c324-4c34-80e3-ca949b8a8dbb",
        "part_idx": 62,
        "ts": "2026-10-06 23:55:30.117+00",
        "text": "countinue where you left off",
        "turn_idx": 9,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "b293b5d8-c324-4c34-80e3-ca949b8a8dbb",
        "part_idx": 71,
        "ts": "2026-10-07 00:04:26.329+00",
        "text": "[Request interrupted by user for tool use]",
        "turn_idx": 13,
        "turn_origin": null,
        "turn_origin_verdict": "machine-surface"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "b293b5d8-c324-4c34-80e3-ca949b8a8dbb",
        "part_idx": 72,
        "ts": "2026-10-07 00:04:32.478+00",
        "text": "AR YOU SURE THE LAST COMMAND WAS SAGE?",
        "turn_idx": 14,
        "turn_origin": "hook-authenticated-prompt",
        "turn_origin_verdict": "owner-typed"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f6a1-9bdd-7142-88e4-12f088a4def7",
        "part_idx": 2,
        "ts": "2026-10-01 08:43:22.496+00",
        "text": "I think we need to create something that gives users of our cloud app at app.papercusp.com a live tutorial, how can we do that?",
        "turn_idx": 1,
        "turn_origin": null,
        "turn_origin_verdict": "unenrolled-origin"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f6a1-9bdd-7142-88e4-12f088a4def7",
        "part_idx": 27,
        "ts": "2026-10-01 08:51:01.558+00",
        "text": "do a thorugh online search what other libraries should we use for this?",
        "turn_idx": 4,
        "turn_origin": null,
        "turn_origin_verdict": "unenrolled-origin"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f6a9-2333-7dd3-a4a9-3434afa55b5b",
        "part_idx": 49,
        "ts": "2026-10-01 09:02:57.856+00",
        "text": "write this into a plan and show me the detailed summary",
        "turn_idx": 8,
        "turn_origin": null,
        "turn_origin_verdict": "unenrolled-origin"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f6a9-2333-7dd3-a4a9-3434afa55b5b",
        "part_idx": 68,
        "ts": "2026-10-01 09:09:18.588+00",
        "text": "across all of our chatgpt accounts how many usage credits have we used so far?",
        "turn_idx": 11,
        "turn_origin": null,
        "turn_origin_verdict": "unenrolled-origin"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f6a9-2333-7dd3-a4a9-3434afa55b5b",
        "part_idx": 69,
        "ts": "2026-10-01 09:09:20.733+00",
        "text": "after you answer that go back to the tutorial plan",
        "turn_idx": 12,
        "turn_origin": null,
        "turn_origin_verdict": "unenrolled-origin"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f6a9-2333-7dd3-a4a9-3434afa55b5b",
        "part_idx": 112,
        "ts": "2026-10-01 09:58:55.184+00",
        "text": "okay put yourself on auto mode and carry the plan to shipped status yourself now",
        "turn_idx": 17,
        "turn_origin": null,
        "turn_origin_verdict": "unenrolled-origin"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f754-26bd-7f73-874f-3b491a334ea3",
        "part_idx": 116,
        "ts": "2026-10-01 12:36:59.688+00",
        "text": "we should have the tutorial agent also use voice to speak to the user",
        "turn_idx": 11,
        "turn_origin": null,
        "turn_origin_verdict": "unenrolled-origin"
      }
    ]
  },
  "limits": [
    "Pre-cutoff179 indexed tool-use native sessions only. The prefix filter does not certify exhaustive owner applicability; synthetic controls and other-session owner directives require separate provenance."
  ]
}

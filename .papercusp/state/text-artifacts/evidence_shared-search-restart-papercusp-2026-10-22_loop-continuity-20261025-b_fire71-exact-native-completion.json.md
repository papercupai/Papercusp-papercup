---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/loop-continuity-20261025-b/fire71-exact-native-completion.json"
updated_at: 1792977111082
_body: "content"
---

{
  "sql": "WITH stamp AS (SELECT id,workspace_id,owner_id,created_at,detail FROM harness_shared.agent_activity WHERE workspace_id='default' AND owner_id='su-45e55f4b-3b99-466a-85fb-973108f644c9' AND kind='lifecycle' AND detail->>'source'='session-ingest' AND detail->>'nonce'='ff6c091d94cdbb70' AND detail->'loopFire'->>'routineId'='rt_papercusp_loop_su_45e55f4b_3b99_466a_85fb_973108f644c9' AND detail->'loopFire'->>'wakeCount'='71') SELECT s.id AS stamp_id,s.created_at AS stamped_at,s.detail,u.workspace_id,u.source_kind,u.session_id,u.turn_idx,u.ts AS prompt_at,u.turn_origin,(SELECT min(n.turn_idx) FROM harness_shared.session_turns n WHERE n.workspace_id=u.workspace_id AND n.source_kind=u.source_kind AND n.session_id=u.session_id AND n.speaker='user' AND n.turn_idx>u.turn_idx) AS next_user_turn_idx,(SELECT max(a.ts) FROM harness_shared.session_turns a WHERE a.workspace_id=u.workspace_id AND a.source_kind=u.source_kind AND a.session_id=u.session_id AND a.speaker='assistant' AND a.turn_idx>u.turn_idx AND a.turn_idx<COALESCE((SELECT min(n.turn_idx) FROM harness_shared.session_turns n WHERE n.workspace_id=u.workspace_id AND n.source_kind=u.source_kind AND n.session_id=u.session_id AND n.speaker='user' AND n.turn_idx>u.turn_idx),2147483647)) AS strict_loop_completion_at FROM stamp s JOIN harness_shared.session_turns u ON u.workspace_id=s.detail->'indexedTurn'->>'workspaceId' AND u.source_kind=s.detail->'indexedTurn'->>'sourceKind' AND u.session_id=s.detail->'indexedTurn'->>'sessionId' AND u.turn_idx::text=s.detail->'indexedTurn'->>'turnIdx' AND u.owner=s.owner_id AND u.speaker='user' AND u.turn_origin='loop-fire'",
  "response": {
    "content": [
      {
        "type": "text",
        "text": "{\"mode\":\"query\",\"rowCount\":1,\"truncated\":false,\"fields\":[\"stamp_id\",\"stamped_at\",\"detail\",\"workspace_id\",\"source_kind\",\"session_id\",\"turn_idx\",\"prompt_at\",\"turn_origin\",\"next_user_turn_idx\",\"strict_loop_completion_at\"],\"elapsedMs\":32,\"rows\":[{\"stamp_id\":\"9304494\",\"stamped_at\":\"2026-10-26 00:35:50.541269+00\",\"detail\":{\"nonce\":\"ff6c091d94cdbb70\",\"origin\":\"loop-fire\",\"source\":\"session-ingest\",\"loopFire\":{\"routineId\":\"rt_papercusp_loop_su_45e55f4b_3b99_466a_85fb_973108f644c9\",\"wakeCount\":71},\"indexedTurn\":{\"turnIdx\":9,\"sessionId\":\"01a1758c-6c85-7061-8557-d43f411bb955\",\"sourceKind\":\"codex\",\"workspaceId\":\"default\"},\"provenanceWorkspaceId\":\"papercusp-workspace\"},\"workspace_id\":\"default\",\"source_kind\":\"codex\",\"session_id\":\"01a1758c-6c85-7061-8557-d43f411bb955\",\"turn_idx\":9,\"prompt_at\":\"2026-10-26 00:35:46.86+00\",\"turn_origin\":\"loop-fire\",\"next_user_turn_idx\":15,\"strict_loop_completion_at\":\"2026-10-26 00:47:00.941+00\"}]}"
      },
      {
        "type": "text",
        "text": "See also: work_items:claimable; plans:list; db:migrations; testing:runs; issues:list / work_items:get; dev:pg_active_queries; dev:pg_table_sizes; dev:pg_health"
      }
    ]
  }
}

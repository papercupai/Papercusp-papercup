-- get-feedback-reliability-usefulness-adoption-2026-10-03#P-006 eight-thread usefulness selection, rule v1.
-- Method: consult conv-request-226ebb1d194d87a2ce94f89fdf04efca906b367b8baf1b336b4e6209ec4c2705 (answer post 1206995).
-- Population: workspace papercusp-workspace consults that are closed_answered at or before asOf, whose latest
-- dispatched walk names an answering owner distinct from the requester, with that owner's first answer post and a
-- requester-authored post-answer close/new_fact post created at or before asOf. P-006 matrix trials
-- (origin_task_ref WI-10005891) are excluded. Order: closed_at DESC, conversation_id ASC; take 8.
-- Fewer than 8 rows means the review fails; hand-picked substitutes are not allowed.
WITH asof AS (SELECT timestamptz '2026-10-26T19:32:28.176Z' AS t),
native AS (
  SELECT s.conversation_id, s.requester_id, s.closed_at, s.origin_task_ref,
    (SELECT w->>'answeringOwnerId' FROM jsonb_array_elements(COALESCE(s.dispatch_attempts, '[]'::jsonb)) w
      WHERE (w->>'dispatched') = 'true' ORDER BY w->>'at' DESC LIMIT 1) AS answerer
  FROM harness_shared.consult_state s, asof
  WHERE s.workspace_id = 'papercusp-workspace' AND s.state = 'closed_answered' AND s.closed_at <= asof.t
),
ans AS (
  SELECT n.*, (SELECT m.post_id FROM harness_shared.consult_post_meta m
      WHERE m.workspace_id = 'papercusp-workspace' AND m.conversation_id = n.conversation_id
        AND m.kind = 'answer' AND m.author_id = n.answerer
      ORDER BY m.created_at, m.post_id LIMIT 1) AS answer_post
  FROM native n
  WHERE n.answerer IS NOT NULL AND n.answerer <> n.requester_id
),
rev AS (
  SELECT a.*, (SELECT m.post_id FROM harness_shared.consult_post_meta m
      JOIN harness_shared.consult_post_meta am ON am.workspace_id = m.workspace_id AND am.post_id = a.answer_post,
      asof
      WHERE m.workspace_id = 'papercusp-workspace' AND m.conversation_id = a.conversation_id
        AND m.author_id = a.requester_id AND m.kind IN ('close', 'new_fact')
        AND m.created_at > am.created_at AND m.created_at <= asof.t
      ORDER BY m.created_at, m.post_id LIMIT 1) AS review_post
  FROM ans a
  WHERE a.answer_post IS NOT NULL
)
SELECT conversation_id, closed_at, requester_id, answerer AS answering_owner_id, answer_post, review_post
FROM rev
WHERE review_post IS NOT NULL AND origin_task_ref IS DISTINCT FROM 'WI-10005891'
ORDER BY closed_at DESC, conversation_id ASC
LIMIT 8;

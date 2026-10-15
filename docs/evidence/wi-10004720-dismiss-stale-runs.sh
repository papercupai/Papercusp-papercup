#!/usr/bin/env bash
# WI-10004720 / plan work-queue-bulk-cleanup-remediation-2026-10-01 P-002.
# Owner Avi decision 2026-10-01 (WI-10004704 thread): dismiss all three stale review runs.
# Product per-row path only (dismiss-item / dismiss-finding → settleRunPhase), never SQL writes.
set -u
NOTE='Owner Avi decision 2026-10-01 (WI-10004704 thread): dismiss stale review run; remediation plan work-queue-bulk-cleanup-remediation-2026-10-01 P-002'
PSQL=(sudo -n -u postgres psql -d papercusp -At)
INBOX=bulk-ef1590f9-6abe-4072-9389-8857864d2b90
ok=0; fail=0
for id in $("${PSQL[@]}" -c "SELECT item_id FROM harness_shared.attention_bulk_run_items WHERE workspace_id='papercusp-workspace' AND run_id='$INBOX' AND (outcome IS NULL OR outcome NOT IN ('auto_resolved','dismissed')) ORDER BY position"); do
  body=$(jq -nc --arg r "$INBOX" --arg i "$id" --arg n "$NOTE" '{op:"dismiss-item",runId:$r,itemId:$i,note:$n}')
  out=$(curl -s -m 60 -X POST http://127.0.0.1:3070/api/admin/attention-bulk-resolve -H 'Content-Type: application/json' -d "$body")
  if echo "$out" | jq -e '.ok == true' >/dev/null 2>&1; then ok=$((ok+1)); else fail=$((fail+1)); echo "FAIL inbox $id :: $out"; fi
done
echo "INBOX run=$INBOX ok=$ok fail=$fail"
for RUN in bulk-7d35ee41-f64f-4150-8e12-35524c481213 bulk-bc6d1eeb-5609-4881-8731-029b5b102682; do
  ok=0; fail=0
  for id in $("${PSQL[@]}" -c "SELECT finding_id FROM harness_shared.plan_cleanup_run_findings WHERE workspace_id='papercusp-workspace' AND run_id='$RUN' AND (outcome IS NULL OR outcome NOT IN ('auto_applied','accepted','dismissed'))"); do
    body=$(jq -nc --arg r "$RUN" --arg i "$id" --arg n "$NOTE" '{op:"dismiss-finding",runId:$r,findingId:$i,note:$n}')
    out=$(curl -s -m 60 -X POST http://127.0.0.1:3070/api/admin/plan-cleanup -H 'Content-Type: application/json' -d "$body")
    if echo "$out" | jq -e '.ok == true' >/dev/null 2>&1; then ok=$((ok+1)); else fail=$((fail+1)); echo "FAIL plan $RUN $id :: $out"; fi
  done
  echo "PLAN run=$RUN ok=$ok fail=$fail"
done
"${PSQL[@]}" -c "SELECT run_id, run_kind, phase FROM harness_shared.attention_bulk_runs WHERE workspace_id='papercusp-workspace' AND run_id IN ('$INBOX','bulk-7d35ee41-f64f-4150-8e12-35524c481213','bulk-bc6d1eeb-5609-4881-8731-029b5b102682')"
echo DONE

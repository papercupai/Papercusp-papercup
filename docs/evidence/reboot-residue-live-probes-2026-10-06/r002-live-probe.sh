#!/usr/bin/env bash
# reboot-residue R-002 live probe v2 (AUTO-BAR-R-002-P-002@5) — normal-operation cold serve through :8788.
# Every reading below is a direct host observation (systemd, sha256sum, curl, journal); none reads the
# gateway's own claims about itself except the clause-named /admin/local-backends row.
set -u
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "START $T0"
LLOG="$HOME/.papercusp/llama-server-ornith.log"
LOGSZ0=$(stat -c %s "$LLOG" 2>/dev/null || echo 0)
echo "PRE ornith=$(systemctl --user is-active llama-ornith.service) kokoro=$(systemctl --user is-active voicemode-kokoro.service) ollama=$(systemctl is-active ollama.service) ollama_nrestarts=$(systemctl show ollama.service -p NRestarts --value)"
echo "PRE embed_device=$(systemctl --user show papercup-embed-sidecar.service -p Environment | tr ' ' '\n' | grep '^PAPERCUSP_EMBED_DEVICE=' | cut -d= -f2) embed_sidecar=$(systemctl --user is-active papercup-embed-sidecar.service)"
echo "PRE gpu=$(nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader)"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | sed 's/^/PRE_GPU_APP /'
S=$(date +%s)
CODE=$(curl -s -o /tmp/r002v2-resp.json -w '%{http_code}' -m 900 http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"maxwell1500/ornith-35b:IQ3_M","max_tokens":256,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}')
echo "COMPLETION_HTTP=$CODE after $(( $(date +%s) - S ))s"
echo "COMPLETION_MODEL=$(grep -o '"model":"[^"]*"' /tmp/r002v2-resp.json | head -1)"
echo "COMPLETION_HAS_CHOICES=$(grep -c '"choices"' /tmp/r002v2-resp.json)"
# Warm read within idle_ttl, immediately after the completion.
MCODE=$(curl -s -o /tmp/r002v2-models.json -w '%{http_code}' -m 20 http://127.0.0.1:11435/v1/models)
echo "MODELS_11435_HTTP=$MCODE"
echo "MODELS_11435_HAS_ORNITH=$(grep -c 'maxwell1500/ornith-35b:IQ3_M' /tmp/r002v2-models.json)"
head -c 400 /tmp/r002v2-models.json; echo
LB=$(curl -s -m 10 http://127.0.0.1:8788/admin/local-backends)
echo "LOCAL_BACKENDS_ORNITH=$(echo "$LB" | grep -o '"id":"ornith-llamaserver"[^}]*"enabled":[a-z]*' | grep -o '"enabled":[a-z]*')"
echo "POST ornith=$(systemctl --user is-active llama-ornith.service) ollama=$(systemctl is-active ollama.service) ollama_nrestarts=$(systemctl show ollama.service -p NRestarts --value) kokoro=$(systemctl --user is-active voicemode-kokoro.service)"
echo "POST gpu=$(nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader)"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | sed 's/^/POST_GPU_APP /'
echo "--- gateway journal since $T0 (ornith/audit/drift/oom/fail)"
journalctl --user -u papercup-inference-gateway.service --since "$T0" --no-pager 2>/dev/null \
  | grep -iE 'ornith|unit audit|drift|on-demand|oom|out of memory|fail' | cut -c1-260 | head -25
echo "GATEWAY_BAD_LINES=$(journalctl --user -u papercup-inference-gateway.service --since "$T0" --no-pager 2>/dev/null | grep -ciE 'oom|out of memory|load fail|failed to load|drift')"
echo "--- llama-ornith journal since $T0"
journalctl --user -u llama-ornith.service --since "$T0" --no-pager 2>/dev/null | cut -c1-200 | head -10
echo "LLAMA_LOG_NEW_BYTES=$(( $(stat -c %s "$LLOG") - LOGSZ0 ))"
echo "LLAMA_LOG_BAD_LINES=$(tail -c +$((LOGSZ0 + 1)) "$LLOG" | grep -ciE 'cudaMalloc failed|out of memory|failed to load model|error loading model')"
echo "LLAMA_LOG_LOADED=$(tail -c +$((LOGSZ0 + 1)) "$LLOG" | grep -ciE 'server is listening|model loaded')"
echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"

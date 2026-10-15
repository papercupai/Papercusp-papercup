#!/usr/bin/env bash
# reboot-residue R-001 live probe (AUTO-BAR-R-001-P-001@5) — AgenticMail API distribution.
# Direct host observations only: systemd, the unit's own exec script, the exec'd node's `npm root -g`,
# /proc argv of the running process, and an HTTP request to the configured API health route.
set -u
UNIT=agenticmail.service
echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
show() { systemctl --user show "$UNIT" -p LoadState,ActiveState,SubState,NRestarts,MainPID | tr '\n' ' '; echo; }
echo "T0 $(show)"
R0=$(systemctl --user show "$UNIT" -p NRestarts --value)
EXECSTART=$(systemctl --user show "$UNIT" -p ExecStart | grep -o 'path=[^ ;]*' | head -1 | cut -d= -f2)
echo "unit_execstart=$EXECSTART"
EXECLINE=$(grep -E '^exec ' "$EXECSTART" | tail -1); echo "script_exec_line=$EXECLINE"
NODE=$(echo "$EXECLINE" | awk '{print $2}' | tr -d '"'); ENTRY=$(echo "$EXECLINE" | awk '{print $3}' | tr -d '"')
echo "exec_node=$NODE"; echo "exec_entry=$ENTRY"
[ -f "$ENTRY" ] && echo ENTRY_EXISTS=yes || echo ENTRY_EXISTS=no
echo "entry_sha256=$(sha256sum "$ENTRY" 2>/dev/null | cut -c1-64)"
NODEBIN=$(dirname "$NODE")
GROOT=$(PATH="$NODEBIN:$PATH" "$NODEBIN/npm" root -g); echo "npm_root_g[$NODEBIN]=$GROOT"
case "$ENTRY" in "$GROOT"/*) echo ENTRY_UNDER_GLOBAL_ROOT=yes;; *) echo ENTRY_UNDER_GLOBAL_ROOT=no;; esac
echo "global_pkg_versions=$("$NODE" -p "require('$GROOT/agenticmail/package.json').version+' agenticmail / '+require('$GROOT/agenticmail/node_modules/@agenticmail/api/package.json').version+' @agenticmail/api'")"
PID=$(systemctl --user show "$UNIT" -p MainPID --value)
ARGV=$(tr '\0' ' ' < /proc/"$PID"/cmdline); echo "live_argv=$ARGV"
[ "$ARGV" = "$NODE $ENTRY " ] && echo LIVE_ARGV_MATCHES_EXEC=yes || echo LIVE_ARGV_MATCHES_EXEC=no
CFG="$HOME/.agenticmail/config.json"
HOSTPORT=$("$NODE" -e "const c=require('$CFG'); process.stdout.write(c.api.host+':'+c.api.port)")
echo "configured_api=$HOSTPORT"
# The server mounts its health router under /api/agenticmail (dist: app.use("/api/agenticmail", createHealthRoutes(...)))
# and prints that URL as its Health banner; a bare /api/health is not a route it serves.
echo "health_route_mount=$(grep -c 'app2.use("/api/agenticmail", createHealthRoutes' "$ENTRY")"
HC=$(curl -s -o /tmp/r001-health.json -w '%{http_code}' -m 10 "http://$HOSTPORT/api/agenticmail/health")
echo "HEALTH_HTTP=$HC body=$(head -c 300 /tmp/r001-health.json)"
echo "literal_api_health_http=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://$HOSTPORT/api/health")"
sleep 60
echo "T1 $(show)"
R1=$(systemctl --user show "$UNIT" -p NRestarts --value)
[ "$R1" = "$R0" ] && echo "NRESTARTS_STABLE=yes ($R0->$R1 over 60s)" || echo "NRESTARTS_STABLE=no ($R0->$R1 over 60s)"
echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"

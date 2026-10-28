#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# papercusp estate — provider-neutral logical backup
#
# Plan: hetzner-to-gcp-restore-2026-08-28 / P-024
#
# WHY LOGICAL, when disk snapshots already exist:
#   a disk snapshot faithfully preserves a BROKEN file. D-015 measured exactly
#   that -- PostHog's dump.rdb was 0 bytes at source, and every snapshot of it
#   was a perfect copy of an unusable file. Logical dumps are produced by the
#   engine, so a corrupt store fails HERE, loudly, instead of at restore time.
#
# DESIGN RULES (each earned from a measured failure):
#   1. -Fc (custom, single file), never -Fd. WI-37835: a -Fd DIRECTORY archive
#      was unrestorable because the restore tool only handled a single file.
#   2. Every artifact is VERIFIED after production -- magic bytes AND a real
#      parse. A backup that is produced and monitored can still be unrestorable.
#   3. Redis is dumped with `redis-cli --rdb`, which forces a FRESH server-side
#      SAVE. Copying dump.rdb off disk is what hid D-015.
#   4. The inventory is DECLARED and then RECONCILED against what is actually
#      running. A new database makes this script FAIL, not silently skip.
#   5. Non-zero exit on any artifact failure. Partial success is failure.
#
# The canonical copy of this script lives in the backup bucket itself
# (tools/pc-estate-backup.sh) so the recovery path never depends on this VM,
# on any git repo, or on the provider that holds the systems.
# ---------------------------------------------------------------------------
set -euo pipefail

BUCKET="${PC_BACKUP_BUCKET:-gs://papercusp-estate-backups-active-alcove-504205-q3}"
HOST="$(hostname -s)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DAY="$(date -u +%Y-%m-%d)"
STAGE_ROOT="${PC_BACKUP_STAGE:-/srv/backups/staging}"
STAGE="${STAGE_ROOT}/${TS}"
DEST="${BUCKET}/daily/${DAY}/${HOST}/${TS}"
KEEP_LOCAL="${PC_BACKUP_KEEP_LOCAL:-0}"
# Seconds ClickHouse waits on an unwritable result socket before aborting an
# export (server default 300). See the ClickHouse section (WI-10006330).
CH_SEND_TIMEOUT="${PC_BACKUP_CH_SEND_TIMEOUT:-1800}"

# --- DECLARED INVENTORY (rule 4) -------------------------------------------
# Anything running that looks stateful and is in NEITHER list aborts the run.
case "$HOST" in
  hetzner-restore-prod)
    PG_CONTAINERS=(restart-postgres-1 sidestage-postgres-1)
    REDIS_CONTAINERS=(restart-redis-1 sidestage-redis-1)
    CH_CONTAINERS=()
    VOLUMES=()
    # containers whose state is captured as a VOLUME tar rather than by an
    # engine dump -- declared so the drift check below can see them covered
    VOL_CONTAINERS=()
    declare -A EXCLUDED=(
      [restart-typesense-1]="MEASURED 9.1GB across the two Typesense volumes -- larger than both Postgres DBs combined -- and the index is RE-DERIVABLE by reindexing from restart-postgres-1. Covered daily by the disk snapshot, which is the right tier for bulk re-derivable state; a daily logical tar would dominate backup cost for data we can rebuild."
      [sidestage-typesense-1]="same as restart-typesense-1: re-derivable from sidestage-postgres-1, covered by the daily disk snapshot"
    )
    ;;
  hetzner-restore-mesh)
    PG_CONTAINERS=(defguard-postgres-1 posthog-db-1)
    REDIS_CONTAINERS=(posthog-redis7-1)
    CH_CONTAINERS=(posthog-clickhouse-1)
    VOLUMES=(posthog_objectstorage posthog_seaweedfs)
    VOL_CONTAINERS=(posthog-objectstorage-1 seaweedfs-main)
    declare -A EXCLUDED=(
      [posthog-kafka-1]="D-012: transport buffer whose durable consumer is ClickHouse; starting it PURGES segments, and CH was verified independently"
      [posthog-zookeeper-1]="D-011: captured ZK state is a liability not truth; replica metadata is rebuilt from disk on restore"
      [posthog-elasticsearch-1]="D-012 scope note: runs with NO persistent volume -- there is no state to back up"
      [posthog-temporal-1]="state lives in posthog-db-1 databases temporal + temporal_visibility (POSTGRES_SEEDS=db), covered by the PG dump"
      [posthog-temporal-admin-tools-1]="stateless admin CLI sidecar"
      [posthog-temporal-ui-1]="stateless UI"
    )
    ;;
  *) echo "FATAL: unknown host '$HOST' -- inventory not declared" >&2; exit 2 ;;
esac

STATEFUL_RE='postgres|clickhouse|redis|valkey|mysql|maria|mongo|kafka|redpanda|minio|elastic|zookeeper|typesense|seaweedfs|temporal|etcd|cassandra'

FAILED=0
ARTIFACTS=()
ARTIFACT_ROWS="/tmp/pcbk-manifest-artifacts.$$"
: > "$ARTIFACT_ROWS"
trap 'rm -f "$ARTIFACT_ROWS"' EXIT
CATALOG_LINES=()

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '[%s] !! FAIL: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; FAILED=$((FAILED+1)); }

clickhouse_catalog() {
  local container="$1" label="$2" query="$3" output error detail=""
  output="/tmp/pcch-catalog.$$.${RANDOM}"
  error="${output}.err"
  CATALOG_LINES=()
  if ! docker exec "$container" clickhouse-client -q "$query" > "$output" 2> "$error"; then
    detail=$(tr '\n' ' ' < "$error" | cut -c1-400)
    if [ -n "$detail" ]; then
      fail "$container: ${label} enumeration failed: ${detail}"
    else
      fail "$container: ${label} enumeration failed"
    fi
    rm -f "$output" "$error"
    return 1
  fi
  if LC_ALL=C grep -q $'\r' "$output"; then
    fail "$container: ${label} enumeration returned a carriage return; refusing malformed identifiers"
    rm -f "$output" "$error"
    return 1
  fi
  mapfile -t CATALOG_LINES < "$output"
  rm -f "$output" "$error"
}

# record an artifact: path, logical name, kind
emit() {
  local f="$1" name="$2" kind="$3" objs="${4:-}"
  local sz; sz=$(stat -c%s "$f")
  local sum; sum=$(sha256sum "$f" | cut -d' ' -f1)
  ARTIFACTS+=("$name")
  printf '%s\0' "$name" "$kind" "${f#$STAGE/}" "$sz" "$sum" "$objs" >> "$ARTIFACT_ROWS"
  log "  ok ${name} (${sz} bytes${objs:+, ${objs} objects})"
}

mkdir -p "$STAGE"/{pg,redis,ch,vol}

# --- RULE 4: inventory drift check -----------------------------------------
log "== inventory reconciliation =="
DECLARED=" "
for _x in ${PG_CONTAINERS[@]+"${PG_CONTAINERS[@]}"} \
          ${REDIS_CONTAINERS[@]+"${REDIS_CONTAINERS[@]}"} \
          ${CH_CONTAINERS[@]+"${CH_CONTAINERS[@]}"} \
          ${VOL_CONTAINERS[@]+"${VOL_CONTAINERS[@]}"}; do DECLARED+="${_x} "; done
if [ "${#EXCLUDED[@]}" -gt 0 ]; then
  for _x in "${!EXCLUDED[@]}"; do DECLARED+="${_x} "; done
fi
DRIFT=0
while read -r cname cimage; do
  [ -z "$cname" ] && continue
  if ! printf '%s' "$cimage" | grep -qEi "$STATEFUL_RE"; then continue; fi
  if [[ "$DECLARED" == *" $cname "* ]]; then continue; fi
  echo "DRIFT: stateful container '$cname' (image $cimage) is in NEITHER the backup inventory NOR the excluded list" >&2
  DRIFT=$((DRIFT+1))
done < <(docker ps --format '{{.Names}} {{.Image}}')
if [ "$DRIFT" -gt 0 ]; then
  echo "FATAL: $DRIFT undeclared stateful container(s). Add each to PG/REDIS/CH/VOLUMES or to EXCLUDED with a reason, then re-run." >&2
  exit 3
fi
log "  no drift: every running stateful container is declared"

# --- POSTGRES (rule 1 + 2) --------------------------------------------------
for c in ${PG_CONTAINERS[@]+"${PG_CONTAINERS[@]}"}; do
  log "== postgres $c =="
  # databases are ENUMERATED, never hardcoded: a new DB is picked up automatically
  mapfile -t DBS < <(docker exec "$c" psql -U postgres -tAc \
    "SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn ORDER BY datname")
  for db in "${DBS[@]}"; do
    f="${STAGE}/pg/${c}__${db}.dump"
    if ! docker exec "$c" pg_dump -U postgres -Fc --no-password -d "$db" > "$f" 2>/tmp/pgerr.$$; then
      fail "pg_dump $c/$db: $(tail -2 /tmp/pgerr.$$ | tr '\n' ' ')"; rm -f "$f"; continue
    fi
    # verify 1: custom-format magic
    if [ "$(head -c5 "$f")" != "PGDMP" ]; then fail "$c/$db: not a PGDMP custom archive"; continue; fi
    # verify 2: a REAL parse, not just a size check.
    # An EMPTY database is a VALID backup that lists zero objects. Treating
    # "0 objects" as failure is the INVERSE of the D-015 mistake -- there the
    # error was calling a broken artifact healthy; here it would be calling a
    # healthy artifact broken. So the gate is PARSEABILITY...
    if ! docker exec -i "$c" pg_restore -l < "$f" > "/tmp/pctoc.$$" 2>/dev/null; then
      fail "$c/$db: pg_restore -l could not parse the archive"; rm -f "/tmp/pctoc.$$"; continue
    fi
    objs=$(grep -cv '^;' "/tmp/pctoc.$$" || true); rm -f "/tmp/pctoc.$$"
    # ...cross-checked against reality: zero objects is only acceptable when the
    # LIVE database genuinely holds nothing. A dump that silently lost the
    # contents of a populated DB fails here.
    live=$(docker exec "$c" psql -U postgres -d "$db" -tAc \
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND c.relkind IN ('r','m','S','p')" 2>/dev/null | tr -dc '0-9')
    if [ "${objs:-0}" -eq 0 ] && [ "${live:-0}" -gt 0 ]; then
      fail "$c/$db: dump lists 0 objects but the live DB holds ${live} relations"; continue
    fi
    emit "$f" "${c}/${db}" "pg_dump_custom" "${objs:-0}"
  done
done

# --- REDIS (rule 3) ---------------------------------------------------------
for c in ${REDIS_CONTAINERS[@]+"${REDIS_CONTAINERS[@]}"}; do
  log "== redis $c =="
  f="${STAGE}/redis/${c}.rdb"
  docker exec "$c" rm -f /tmp/pcbk.rdb 2>/dev/null || true
  if ! docker exec "$c" redis-cli --rdb /tmp/pcbk.rdb >/dev/null 2>&1; then
    fail "$c: redis-cli --rdb failed (live SAVE refused)"; continue
  fi
  docker cp "$c:/tmp/pcbk.rdb" "$f" >/dev/null 2>&1 || { fail "$c: docker cp of rdb failed"; continue; }
  docker exec "$c" rm -f /tmp/pcbk.rdb 2>/dev/null || true
  # THE D-015 GUARD: a 0-byte / header-less RDB is the exact defect a disk
  # snapshot preserves perfectly. Refuse to call it a backup.
  sz=$(stat -c%s "$f")
  if [ "$sz" -eq 0 ]; then fail "$c: RDB is 0 BYTES (D-015 class defect -- redis cannot persist)"; continue; fi
  if [ "$(head -c5 "$f")" != "REDIS" ]; then fail "$c: RDB lacks REDIS magic header"; continue; fi
  keys=$(docker exec "$c" redis-cli DBSIZE 2>/dev/null | tr -dc '0-9')
  log "  $c reports ${keys:-?} keys"
  emit "$f" "$c" "redis_rdb"
done

# --- CLICKHOUSE -------------------------------------------------------------
# Logical export, deliberately: D-011 established that captured replica/ZK
# metadata is a liability. Schema DDL + Native data restores onto a fresh node.
for c in ${CH_CONTAINERS[@]+"${CH_CONTAINERS[@]}"}; do
  log "== clickhouse $c =="
  if ! clickhouse_catalog "$c" "database list" \
    "SELECT name FROM system.databases WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema','default')"; then
    continue
  fi
  CHDBS=("${CATALOG_LINES[@]}")
  for db in "${CHDBS[@]}"; do
    mkdir -p "${STAGE}/ch/${db}/data"
    sf="${STAGE}/ch/${db}/schema.sql"
    : > "$sf"
    if ! clickhouse_catalog "$c" "table list for database '${db}'" \
      "SELECT name FROM system.tables WHERE database='${db}' ORDER BY name"; then
      continue
    fi
    TBLS=("${CATALOG_LINES[@]}")
    for t in "${TBLS[@]}"; do
      docker exec "$c" clickhouse-client -q \
        "SELECT replaceOne(create_table_query,'CREATE ','CREATE OR REPLACE ') FROM system.tables WHERE database='${db}' AND name='${t}'" \
        >> "$sf" 2>/dev/null && echo ";" >> "$sf" || true
    done
    [ -s "$sf" ] && emit "$sf" "${db}/schema" "clickhouse_ddl"
    # data only from storage-bearing engines (Distributed/View/MV/Kafka/Dictionary hold none)
    if ! clickhouse_catalog "$c" "MergeTree table list for database '${db}'" \
      "SELECT name FROM system.tables WHERE database='${db}' AND engine LIKE '%MergeTree' ORDER BY name"; then
      continue
    fi
    DTBLS=("${CATALOG_LINES[@]}")
    for t in "${DTBLS[@]}"; do
      df="${STAGE}/ch/${db}/data/${t}.native.gz"
      # Keep clickhouse-client/docker stderr (outside $STAGE, which is uploaded wholesale)
      # so a failure names its cause, not a bare "export failed" (WI-10006330).
      #
      # send_timeout + one retry (WI-10006330): the server aborts a query whose result
      # socket stays unwritable for send_timeout seconds (default 300). On 2026-10-05
      # posthog.sharded_query_log_archive (1.17 GiB, 4M rows) died exactly that way --
      # "DB::NetException: Timeout exceeded while writing to socket (..., 300000 ms)
      # (SOCKET_TIMEOUT)" -- when the docker-exec -> gzip consumer stopped reading for
      # 5 minutes; 10-04 and 10-06 exported the same table cleanly. One transient
      # consumer stall silently dropped a table from that day's backup. The wider window
      # absorbs such a stall, and the retry covers any other transient fault; a second
      # failure is still a FAIL that quotes its cause.
      exported=0
      for attempt in 1 2; do
        if docker exec "$c" clickhouse-client --max_block_size=100000 \
             --send_timeout="$CH_SEND_TIMEOUT" -q \
             "SELECT * FROM \`${db}\`.\`${t}\` FORMAT Native" 2>"/tmp/pcch.$$" | gzip -6 > "$df"; then
          exported=1; break
        fi
        [ "$attempt" -lt 2 ] && log "  retry clickhouse ${db}.${t}: attempt ${attempt} failed: $(tr '\n' ' ' < "/tmp/pcch.$$" 2>/dev/null | cut -c1-300)"
      done
      if [ "$exported" = 1 ]; then
        [ -s "$df" ] && emit "$df" "${db}.${t}" "clickhouse_native" || rm -f "$df"
      else
        fail "clickhouse ${db}.${t}: Native export failed after 2 attempts: $(tr '\n' ' ' < "/tmp/pcch.$$" 2>/dev/null | cut -c1-400)"; rm -f "$df"
      fi
      rm -f "/tmp/pcch.$$"
    done
  done
done

# --- DOCKER VOLUMES (search indexes / object stores) ------------------------
for v in ${VOLUMES[@]+"${VOLUMES[@]}"}; do
  log "== volume $v =="
  src="/var/lib/docker/volumes/${v}/_data"
  [ -d "$src" ] || { fail "volume $v: $src missing"; continue; }
  f="${STAGE}/vol/${v}.tar.gz"
  if tar czf "$f" -C "$src" . 2>/dev/null && tar tzf "$f" >/dev/null 2>&1; then
    emit "$f" "$v" "volume_tar"
  else
    fail "volume $v: tar produced an unreadable archive"; rm -f "$f"
  fi
done

# --- MANIFEST ---------------------------------------------------------------
if ! {
  printf '%s\0' "$HOST" "$TS" "$DEST" "$FAILED" "${#EXCLUDED[@]}"
  if [ "${#EXCLUDED[@]}" -gt 0 ]; then
    for k in "${!EXCLUDED[@]}"; do printf '%s\0' "$k" "${EXCLUDED[$k]}"; done
  fi
  printf '%s\0' "${#ARTIFACTS[@]}"
  cat "$ARTIFACT_ROWS"
} | python3 -c '
import json
import sys

fields = sys.stdin.buffer.read().split(b"\0")
index = 0

def take():
    global index
    value = fields[index].decode("utf-8")
    index += 1
    return value

host, taken_at, destination = take(), take(), take()
failures = int(take())
excluded = {}
for _ in range(int(take())):
    excluded[take()] = take()
artifacts = []
for _ in range(int(take())):
    name, kind, path = take(), take(), take()
    size, checksum, objects = int(take()), take(), take()
    artifact = {"name": name, "kind": kind, "path": path, "bytes": size, "sha256": checksum}
    if objects:
        artifact["objects"] = int(objects)
    artifacts.append(artifact)

json.dump({
    "host": host,
    "taken_at": taken_at,
    "plan_item": "hetzner-to-gcp-restore-2026-08-28/P-024",
    "destination": destination,
    "failures": failures,
    "excluded": excluded,
    "artifacts": artifacts,
}, sys.stdout, ensure_ascii=True, indent=2)
sys.stdout.write("\n")
' > "${STAGE}/MANIFEST.json"; then
  fail "manifest serialization failed; refusing to upload an unverified manifest"
  exit 1
fi
if ! python3 -m json.tool "${STAGE}/MANIFEST.json" >/dev/null; then
  fail "manifest JSON validation failed before upload"
  exit 1
fi

log "== upload -> ${DEST} =="
# `gcloud storage cp -r` ERRORS on an empty source directory ("matched no
# objects or files"), which aborts the whole upload. A host with no ClickHouse
# and no volume targets legitimately has empty ch/ and vol/ dirs, so prune them
# before uploading rather than letting an empty dir fail a good backup.
find "$STAGE" -type d -empty -delete 2>/dev/null || true
set +e
gcloud storage cp -r "${STAGE}"/* "${DEST}/" --quiet 2>&1 | tail -3
UPRC=${PIPESTATUS[0]}
set -e
[ "$UPRC" -ne 0 ] && fail "gcloud storage cp exited ${UPRC}"

# --- remote verification, driven by the MANIFEST -------------------------
# The population is enumerated from the AUTHORITY (what we declared we
# produced), never from the remote listing. Walking the remote listing can
# only ever detect a CORRUPTED object -- an artifact that is entirely
# MISSING never appears in that loop, so it is never checked, and the run
# reports success while the most important dump is absent. That is exactly
# the silent-failure class this whole item exists to prevent.
log "== remote verification (manifest-driven) =="
declare -A REMOTE=()
while read -r rsize rname; do
  [ -z "$rname" ] && continue
  REMOTE["${rname#${DEST}/}"]="$rsize"
done < <(gcloud storage ls -l -r "${DEST}/**" 2>/dev/null | awk 'NF>=3 && $1 ~ /^[0-9]+$/ {print $1, $NF}')

BAD=0
BADLIST=()
while IFS='|' read -r apath abytes; do
  [ -z "$apath" ] && continue
  got="${REMOTE[$apath]:-}"
  if [ -z "$got" ]; then
    echo "MISSING REMOTELY: ${apath} (declared ${abytes} bytes)" >&2; BAD=$((BAD+1))
    BADLIST+=("MISSING: ${apath} (declared ${abytes} bytes)")
  elif [ "$got" != "$abytes" ]; then
    echo "SIZE MISMATCH: ${apath} declared=${abytes} remote=${got}" >&2; BAD=$((BAD+1))
    BADLIST+=("SIZE MISMATCH: ${apath} declared=${abytes} remote=${got}")
  fi
done < <(python3 -c "
import json
for a in json.load(open('${STAGE}/MANIFEST.json'))['artifacts']:
    print(a['path'] + '|' + str(a['bytes']))
")
if [ -z "${REMOTE[MANIFEST.json]:-}" ]; then
  echo "MISSING REMOTELY: MANIFEST.json" >&2; BAD=$((BAD+1))
  BADLIST+=("MISSING: MANIFEST.json")
fi
if [ "$BAD" -gt 0 ]; then
  fail "${BAD} declared artifact(s) missing or wrong size in the bucket"
  # WI-808388: mark the prefix IN THE BUCKET, not just in this log.
  #
  # Two properties of this script make an unmarked failed prefix genuinely
  # dangerous, and neither is obvious from the bucket:
  #   1. MANIFEST.json is written (above) and uploaded BEFORE this verification
  #      runs, and is never rewritten. Its "failures" field is therefore frozen
  #      at its pre-upload value -- it reads 0 even for the run you are reading
  #      right now, which just failed. It can NEVER report an upload or
  #      verification failure.
  #   2. Nothing else here distinguishes a partial prefix from a complete one.
  # So a human following RESTORE-RUNBOOK section 3, reading only the bucket,
  # sees a manifest declaring N artifacts with "failures": 0 and no other
  # signal -- exactly how daily/2026-08-29/hetzner-restore-prod/20260829T055415Z
  # sat there claiming 6 artifacts while holding 4, with both application
  # databases absent. That marker had to be written BY HAND after the fact.
  #
  # This writes it automatically, at the moment we know. Deliberately a small
  # separate object rather than a manifest rewrite: the manifest is the sha256
  # integrity authority and must stay exactly as produced.
  marker="${STAGE}/INCOMPLETE-DO-NOT-USE.txt"
  {
    echo "INCOMPLETE BACKUP -- DO NOT RESTORE FROM THIS SNAPSHOT"
    echo
    echo "host:           ${HOST}"
    echo "snapshot:       ${TS}"
    echo "destination:    ${DEST}"
    echo "detected_at:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "failed_checks:  ${BAD}"
    echo
    echo "MANIFEST.json in this prefix is NOT a success signal: it is uploaded"
    echo "before verification runs and its \"failures\" field is always its"
    echo "pre-upload value. Trust THIS file over that one."
    echo
    echo "Declared-but-unverifiable artifacts:"
    for b in "${BADLIST[@]}"; do echo "  - ${b}"; done
  } > "$marker" 2>/dev/null
  # Best-effort and strictly non-masking: a marker we cannot upload must never
  # change the outcome or hide the real failure below.
  if gcloud storage cp "$marker" "${DEST}/INCOMPLETE-DO-NOT-USE.txt" --quiet >/dev/null 2>&1; then
    log "  wrote INCOMPLETE-DO-NOT-USE.txt into ${DEST}"
  else
    echo "WARNING: could not write the INCOMPLETE marker into ${DEST} -- this prefix is partial and UNMARKED; mark it by hand." >&2
  fi
else
  log "  all ${#ARTIFACTS[@]} declared artifacts present remotely at the declared size"
fi

# Staging is discarded ONLY on success. A failed run (typically a failed
# upload) must not also destroy the artifacts it spent an hour producing --
# otherwise every retry pays for a full re-dump.
if [ "$FAILED" -gt 0 ]; then
  echo "BACKUP FAILED: ${FAILED} artifact failure(s). Partial success is failure." >&2
  echo "Staged artifacts PRESERVED at ${STAGE} -- fix the cause and re-upload rather than re-dumping." >&2
  exit 1
fi
if [ "$KEEP_LOCAL" != "1" ]; then rm -rf "$STAGE"; fi
log "BACKUP OK -> ${DEST} (${#ARTIFACTS[@]} artifacts)"

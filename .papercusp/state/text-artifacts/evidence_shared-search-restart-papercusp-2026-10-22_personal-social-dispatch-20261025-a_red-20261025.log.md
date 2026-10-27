---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/personal-social-dispatch-20261025-a/red-20261025.log"
updated_at: 1792955727981
_body: "content"
---

[with-test-pg] booting throwaway PG on :33803 (datadir /tmp/pcv/papercusp-test-pg-gqp5mY)
[with-test-pg] migrations: /home/marsh-office/papercupai-workspace/papercusp/libs/papercusp/libs/db/sql
[with-test-pg] pg preload: pg_textsearch
[with-test-pg] pg initialising data dir at /tmp/pcv/papercusp-test-pg-gqp5mY
[with-test-pg] pg pg: The files belonging to this database system will be owned by user "marsh-office".
This user must also own the server process.


[with-test-pg] pg pg: The database cluster will be initialized with locale "C".
The default text search configuration will be set to "english".

Data page checksums are enabled.

fixing permissions on existing directory /tmp/pcv/papercusp-test-pg-gqp5mY ... ok
creating subdirectories ... 
[with-test-pg] pg pg: ok

[with-test-pg] pg pg: selecting dynamic shared memory implementation ... posix
selecting default "max_connections" ... 
[with-test-pg] pg pg: 100
selecting default "shared_buffers" ... 
[with-test-pg] pg pg: 128MB
selecting default time zone ... 
[with-test-pg] pg pg: America/New_York
creating configuration files ... 
[with-test-pg] pg pg: ok
running bootstrap script ... 
[with-test-pg] pg pg: ok

[with-test-pg] pg pg: performing post-bootstrap initialization ... 
[with-test-pg] pg pg: ok
syncing data to disk ... 
[with-test-pg] pg pg: ok

Success. You can now start the database server using:

    '/home/marsh-office/papercupai-workspace/papercusp/libs/papercusp/packages/embedded-postgres-server/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl' -D /tmp/pcv/papercusp-test-pg-gqp5mY -l logfile start


[with-test-pg] pg starting postgres on localhost:33803
[with-test-pg] pg pg: 2026-10-25 15:05:50.392 EDT [3318895] LOG:  starting PostgreSQL 18.4 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit

[with-test-pg] pg pg: 2026-10-25 15:05:50.392 EDT [3318895] LOG:  listening on IPv4 address "127.0.0.1", port 33803

[with-test-pg] pg pg: 2026-10-25 15:05:50.395 EDT [3318918] LOG:  database system was shut down at 2026-10-25 15:05:49 EDT

[with-test-pg] pg pg: 2026-10-25 15:05:50.399 EDT [3318895] LOG:  database system is ready to accept connections

[with-test-pg] pg creating database papercusp
[with-test-pg] pg apply 000-baseline.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "harness_shared" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "requested_n" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "actual_n" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tier_label" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "available_at_decision" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "max_slots" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "outcome" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "outcome_ts" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "synthesized" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "synthesis_error" of relation "adaptive_telemetry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plan_slug" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mode" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "terminal_bin" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pid" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "window_id" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "omp_thread_id" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "label" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cwd" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ended_at" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "exit_code" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "coord_owner_id" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature" of relation "adv_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "command_id" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "args" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_code" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "session_id" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "request_id" of relation "agent_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "transcript" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "total_input_tokens" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "total_output_tokens" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "total_cost_usd_cents" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "archived_at" of relation "agent_chats_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "agent_queries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "agent_queries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent" of relation "agent_queries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "query_id" of relation "agent_queries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "args_compact" of relation "agent_queries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace" of relation "agent_queries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "request_id" of relation "agent_queries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "size_bytes" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_usd" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "input_tokens" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "output_tokens" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cache_read_tokens" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cache_creation_tokens" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "running" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_event_ts" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "agent_runs_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "actor" of relation "audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "action" of relation "audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "subject" of relation "audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "details" of relation "audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "_search" of relation "audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "username" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ip" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_agent" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ok" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_code" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "session_hmac" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata" of relation "auth_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "key" of relation "auth_rate_limit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "auth_rate_limit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "auth_rate_limit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pr_number" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pr_url" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author_github_id" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "reviewer_github_id" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "action" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "detail" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "auto_review_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "autoloop_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "autoloop_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_fired_at" of relation "autoloop_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_status" of relation "autoloop_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "consecutive_errors" of relation "autoloop_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "autoloop_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "backup_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "backup_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "snapshot_id" of relation "backup_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "backup_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload_json" of relation "backup_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "at" of relation "backup_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kopia_snapshot_id" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "finished_at" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trigger_reason" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trigger_context" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "bytes_added" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "bytes_total" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "sources_json" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_text" of relation "backup_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "claim_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "claim_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "claim_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "claim_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimer_pubkey" of relation "claim_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "attempt_ts" of relation "claim_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "outcome" of relation "claim_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "detail" of relation "claim_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "event_id" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_user_id" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "device_pubkey" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ref_id" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "schema_version" of relation "contributor_usage_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_user_id" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_username" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "display_name" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "avatar_url" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "device_attestations" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "revoked_pubkeys" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "joined_at" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_seen_at" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "schema_version" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "binding_status" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "channel1_verified_at" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "channel2_verified_at" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "channel2_branch_ref" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "binding_last_checked_at" of relation "contributors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "key" of relation "cooldown_marks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "marked_at_ms" of relation "cooldown_marks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "cooldown_marks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "coord_event_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "coord_event_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "surface" of relation "coord_event_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "writer_key" of relation "coord_event_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "msg_id" of relation "coord_event_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "coord_event_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "coord_event_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "owner_id" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "owner_label" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "intent" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "current_plan_slug" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "current_files" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "host" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pid" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "heartbeat_at" of relation "coord_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "msg_id" of relation "coord_subscriptions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "coord_subscriptions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "owner_id" of relation "coord_subscriptions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pattern" of relation "coord_subscriptions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trigger" of relation "coord_subscriptions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_ts" of relation "coord_subscriptions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cancelled_at" of relation "coord_subscriptions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "coord_subscriptions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "coord_watermarks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "owner_id" of relation "coord_watermarks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "surfaces" of relation "coord_watermarks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "coord_watermarks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "delegate_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "delegate_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "delegate_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "delivered_at" of relation "delegate_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "delegate_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "headline" of relation "delegate_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent_session_id" of relation "delegate_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent_session_id" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "summary" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_active_at" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "turn_count" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "origin" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "initiator_msg" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "transcript" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent_backend" of relation "delegates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "el_conv_calls" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "el_conv_calls" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "conversation_id" of relation "el_conv_calls" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent_id" of relation "el_conv_calls" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace" of relation "el_conv_calls" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_secs" of relation "el_conv_calls" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ym" of relation "el_conv_calls" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "field" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "old_value" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "new_value" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "actor" of relation "feature_audit_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "seq" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimer_pubkey" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimer_github_user_id" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimed_at" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "outcome" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "schema_version" of relation "feature_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_user_id" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "queued_at" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "removed_at" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author_pubkey" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "origin" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "schema_version" of relation "feature_queue" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_user_id" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cleared_at" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author_pubkey" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "origin" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "schema_version" of relation "feature_working_set" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "table_name" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "op" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "key" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "row" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "exported_at" of relation "git_export_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "install_slug" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parent_id" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "budget_cents" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "_search" of relation "goals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_archives" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_archives" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "harness_archives" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "size_bytes" of relation "harness_archives" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_archives" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_archives" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "canvas" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mindmap" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content_tsv" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_branch_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "branch" of relation "harness_branch_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "harness_branch_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_check_ms" of relation "harness_branch_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_branch_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_checkpoints" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "harness_checkpoints" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "harness_checkpoints" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "waiting_since_ms" of relation "harness_checkpoints" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "granted" of relation "harness_checkpoints" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_checkpoints" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "consumed" of relation "harness_checkpoints" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "chunk_id" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "chunk_index" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "files" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "description" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "strikes" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_error" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "commit_sha" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spawned_by_spawn_id" of relation "harness_chunk_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "line_hash" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "iso" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "verb" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "args" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "iteration" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "is_ghost" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_tsv" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "harness_design_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_design_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_design_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "harness_design_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "harness_design_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata" of relation "harness_design_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "harness_design_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_dispatches" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parent_slug" of relation "harness_dispatches" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "child_slug" of relation "harness_dispatches" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "child_role" of relation "harness_dispatches" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "dispatch_at" of relation "harness_dispatches" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "result_body" of relation "harness_dispatches" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_dock_layouts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_id" of relation "harness_dock_layouts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "layout_name" of relation "harness_dock_layouts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "schema_version" of relation "harness_dock_layouts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "layout_json" of relation "harness_dock_layouts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "harness_dock_layouts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "harness_dock_layouts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "escalation" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "supervisor_notes" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_tsv" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_expert_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_expert_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expert_id" of relation "harness_expert_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feedback_id" of relation "harness_expert_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "persona" of relation "harness_expert_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "verdict" of relation "harness_expert_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "harness_expert_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ended_at" of relation "harness_expert_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_expert_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_expert_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expert_id" of relation "harness_expert_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feedback_id" of relation "harness_expert_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "turn_idx" of relation "harness_expert_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "speaker" of relation "harness_expert_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "harness_expert_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "harness_expert_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expert_id" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "budget_cents" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_size" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "high_level_spec" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent_count" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "round_count" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "personas_used" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_engaged" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "termination_reason" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spec_content" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "assertions_content" of relation "harness_experts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_feature_debug_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_feature_debug_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_feature_debug_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "harness_feature_debug_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_feature_debug_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_feature_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_feature_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_feature_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "harness_feature_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_feature_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_feature_prs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_feature_prs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_feature_prs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pr_url" of relation "harness_feature_prs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pr_state" of relation "harness_feature_prs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "opened_ts" of relation "harness_feature_prs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "harness_feature_prs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "summary" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "attempts" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claims" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "notes" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "project_id" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expected_cost_cents" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tags" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "needs_human_review" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parent_id" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "goal_id" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "taken_by" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "taken_at" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "_search" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "deprecation_reason" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "see_also" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "needs_design" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "design_status" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "design_spec_id" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "discarded_design_work" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "completion_ref" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_by_github_user_id" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "working_users" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "worked_by_history" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "verified_done_at_remote_ts" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "verifier_last_error" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "verifier_last_checked_at" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source_plan_slug" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source_plan_item_ids" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "wave" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_order" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author_pubkey" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "origin" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "audit_verdict" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "audit_reasons" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "audited_at" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_generator_items" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_generator_items" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_generator_items" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "items" of relation "harness_generator_items" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "harness_generator_items" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_git_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "sha" of relation "harness_git_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parents" of relation "harness_git_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "subject" of relation "harness_git_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author" of relation "harness_git_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_git_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "refs" of relation "harness_git_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_git_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_health" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spec_present" of relation "harness_health" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "contract_present" of relation "harness_health" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_check_ms" of relation "harness_health" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_health" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_hook_logs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "log_id" of relation "harness_hook_logs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "harness_hook_logs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_hook_logs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "size_bytes" of relation "harness_hook_logs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_hook_logs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "issue_id" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "severity" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "found_at" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "found_during" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "repro" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "evidence" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "suggested_fix" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "code_pointer" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "linked_feature_id" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "attempts" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "notes" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author_pubkey" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "origin" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_issues_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_lanes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_lanes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "harness_lanes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_lanes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pid" of relation "harness_lanes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "harness_lanes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_lanes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_mission_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_mission_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_warn_fired" of relation "harness_mission_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ready_for_prod_at" of relation "harness_mission_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "lanes" of relation "harness_mission_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_mission_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "issue_id" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "severity" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_pending_issues" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_phase_last_used" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_phase_last_used" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_id" of relation "harness_phase_last_used" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_phase_last_used" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "harness_phase_last_used" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase_path" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "branch" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "port" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "public_url" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "exists_on_disk" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "alive" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "passed_count" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "total_count" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_usd" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "iteration" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "promotion_in_flight" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_phases" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "val_id" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plan_slug" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "item_id" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "verify_text" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "evidence_text" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "requires_test" of relation "harness_plan_assertions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_plan_review" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "harness_plan_review" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_plan_review" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_plan_review" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_plan_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_plan_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plan_slug" of relation "harness_plan_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_plan_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "harness_plan_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_plan_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "current_wave" of relation "harness_plan_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "priority" of relation "harness_plan_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_project_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spec" of relation "harness_project_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agents" of relation "harness_project_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "contract" of relation "harness_project_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "config" of relation "harness_project_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_project_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_project_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "version" of relation "harness_project_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_promotions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_promotions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "promotion_id" of relation "harness_promotions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "from_phase" of relation "harness_promotions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "to_phase" of relation "harness_promotions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "sha" of relation "harness_promotions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_promotions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_prompt_overrides" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_prompt_overrides" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "harness_prompt_overrides" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "prompt_md" of relation "harness_prompt_overrides" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_prompt_overrides" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "proposal_id" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "review_verdict" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "review_summary" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "reviewed_at" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "applied_at" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "rejected_at" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "size_bytes" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_proposals_shared" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_registry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "harness_registry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_registry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_run_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_run_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "harness_run_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "seq" of relation "harness_run_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "chunk_data" of relation "harness_run_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_run_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "prompt_body" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "jsonl_body" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "out_body" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "err_body" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "exit_code" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ended_at" of relation "harness_run_output" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_screenshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_screenshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "harness_screenshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "size_bytes" of relation "harness_screenshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_screenshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_screenshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_skills" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_skills" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "harness_skills" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "harness_skills" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_skills" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_smoke_test" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_smoke_test" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pass_content" of relation "harness_smoke_test" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "failure_content" of relation "harness_smoke_test" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "results" of relation "harness_smoke_test" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "startup_log" of relation "harness_smoke_test" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_smoke_test" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_smoke_test" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "snapshot_id" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "iteration" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "features_json" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "validation_md" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "notes_md" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "config_json" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "taken_at" of relation "harness_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_snapshots_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "snapshot_id" of relation "harness_snapshots_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "harness_snapshots_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "iter_num" of relation "harness_snapshots_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "files" of relation "harness_snapshots_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_counts" of relation "harness_snapshots_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "harness_snapshots_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "harness_snapshots_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "iteration" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "total_features" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "passed_count" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "todo_count" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "blocked_count" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_active_ts" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_usd" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at" of relation "harness_status" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "harness_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "test_id" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_run_ts" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_tests" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "harness_text_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "rel_path" of relation "harness_text_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "harness_text_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "harness_text_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "harness_text_artifacts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "basename" of relation "hidden_plugins" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "reason" of relation "hidden_plugins" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "hidden_at" of relation "hidden_plugins" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "hidden_by" of relation "hidden_plugins" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "hidden_plugins" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "identity_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "identity_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "bytes" of relation "identity_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "identity_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "identity_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "identity_files" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "insights_first_visit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "insights_first_visit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_id" of relation "insights_first_visit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "seen_at_ts" of relation "insights_first_visit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "known_schema_versions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "known_schema_versions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "max_known_version" of relation "known_schema_versions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "known_schema_versions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claim_key" of relation "llm_test_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "owner_id" of relation "llm_test_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "scenario_id" of relation "llm_test_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "identity_hash" of relation "llm_test_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "matrix_index" of relation "llm_test_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "acquired_at" of relation "llm_test_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at" of relation "llm_test_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata_json" of relation "llm_test_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "severity" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "axis" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "assert_kind" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "shape" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "evidence_turn_idx" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claim" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "suggestion" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "copy_prompt" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "promoted_to_assert_id" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "promoted_from" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "acknowledged" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "acknowledged_by" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "acknowledged_at" of relation "llm_test_findings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "llm_test_fixtures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "scenario_id" of relation "llm_test_fixtures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "label" of relation "llm_test_fixtures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "sse_tape_json" of relation "llm_test_fixtures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_inputs_json" of relation "llm_test_fixtures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "recorded_at" of relation "llm_test_fixtures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "recorded_from_run_id" of relation "llm_test_fixtures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "scenario_id" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "scenario_version" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "scenario_target" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "scenario_hash" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "identity_hash" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "matrix_group_id" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "matrix_index" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "rubric_version" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "sut_model" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "judge_model" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "persona_id" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "persona_traits_json" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_mode" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "transport_mode" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "finished_at" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_usd" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cap_breaches" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "scores_json" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "findings_count" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "transcript_raw_zstd" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "transcript_norm_json" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "telemetry_json" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "asserts_json" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "judge_json" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata_json" of relation "llm_test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "memory_id" of relation "memory_anchors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "memory_anchors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "value" of relation "memory_anchors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "memory_anchors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_checked_at" of relation "memory_anchors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_check_ok" of relation "memory_anchors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "memory_canonical" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "memory_canonical" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "memory_canonical" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "memory_canonical" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_validated_at" of relation "memory_canonical" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_surfaced_at" of relation "memory_canonical" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "state" of relation "memory_canonical" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mem_id" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_id" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "action" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "prior_text" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "new_text" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "memory_feedback" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "memory_id" of relation "memory_vec_local" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedded_at" of relation "memory_vec_local" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "memory_id" of relation "memory_vec_openai" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedded_at" of relation "memory_vec_openai" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "device_id" of relation "mobile_devices" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_email" of relation "mobile_devices" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "mobile_devices" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "device_kind" of relation "mobile_devices" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "device_label" of relation "mobile_devices" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "paired_at" of relation "mobile_devices" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_seen" of relation "mobile_devices" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "revoked_at" of relation "mobile_devices" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pair_token" of relation "mobile_pair_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "mobile_pair_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_email" of relation "mobile_pair_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "desktop_host" of relation "mobile_pair_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at_ms" of relation "mobile_pair_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "consumed" of relation "mobile_pair_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at_ms" of relation "mobile_pair_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "device_id" of relation "mobile_push_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "platform" of relation "mobile_push_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "token" of relation "mobile_push_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "registered_at" of relation "mobile_push_tokens" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "nonce" of relation "oauth_nonces" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "exp_ms" of relation "oauth_nonces" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "consumed" of relation "oauth_nonces" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "oauth_nonces" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_agent_config" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_agent_config" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_agent_config" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_budget" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_budget" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_budget" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ord" of relation "operator_budget_tiers" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "label" of relation "operator_budget_tiers" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cap_usd" of relation "operator_budget_tiers" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "blurb" of relation "operator_budget_tiers" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_slug" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "machine_id" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pid" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "script_hash" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimed_at" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_claims" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "conversation_id" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ui_client_id" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "chain_id" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "turn_idx" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trigger" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "elapsed_secs_in_chain" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "was_capped" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cap_reason" of relation "operator_continue_chains" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ended_at" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "el_conversation_ids" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "has_audio" of relation "operator_conversations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload_ct" of relation "operator_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_dismissed_cards" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "card_id" of relation "operator_dismissed_cards" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "dismissed_at" of relation "operator_dismissed_cards" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_first_run" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_first_run" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_first_run" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_idle_snapshot" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_idle_snapshot" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_idle_snapshot" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_last_scan" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_last_scan" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_last_scan" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_marketplace_token" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_marketplace_token" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_marketplace_token" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload_ct" of relation "operator_marketplace_token" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_oracle_memory" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_oracle_memory" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_oracle_memory" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_oracle_prompt" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_oracle_prompt" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_oracle_prompt" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_paused" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_paused" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_paused" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_preferences" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_preferences" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_preferences" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_prompt_user" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_prompt_user" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_prompt_user" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_publish_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_publish_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_publish_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload_ct" of relation "operator_publish_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_rate_limit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_rate_limit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_rate_limit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_scan_locks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "operator_scan_locks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "holder_id" of relation "operator_scan_locks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at" of relation "operator_scan_locks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_scanner_session" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_scanner_session" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_scanner_session" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ended_at" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "agent_session_id" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "request_text" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "summary" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "suggestions" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "suggestion_count" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_usd" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cached" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error" of relation "operator_scans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_search_provider_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_search_provider_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload_ct" of relation "operator_search_provider_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_search_provider_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "operator_secrets" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "value_b64" of relation "operator_secrets" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "operator_secrets" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "rotated_at" of relation "operator_secrets" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "key" of relation "operator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "value" of relation "operator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "description" of relation "operator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_standing_candidates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_standing_candidates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_standing_candidates" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_stt_spend" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_stt_spend" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_stt_spend" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_trust_store" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_trust_store" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_trust_store" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload_ct" of relation "operator_trust_store" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_tts_spend" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_tts_spend" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_tts_spend" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "conversation_id" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "seq" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "text" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "el_conv_id" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "audio_url" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "text_tsv" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tools" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_user_profile" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_user_profile" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_user_profile" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_voice_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_voice_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_voice_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload_ct" of relation "operator_voice_credentials" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "operator_voice_prefs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "operator_voice_prefs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "operator_voice_prefs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "orchestrator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tiers" of relation "orchestrator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "labels" of relation "orchestrator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "rubric" of relation "orchestrator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "orchestrator_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "org_id" of relation "org_charter" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "org_charter" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "org_charter" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "org_charter" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "org_id" of relation "org_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "dept_slug" of relation "org_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "org_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "org_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "org_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "org_id" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "dept_slug" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mandate" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "inbox_kinds" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "outbox_kinds" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "org_departments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "org_id" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "dept_slug" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "message_id" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "msg_from" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "msg_to" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "subject" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ref_id" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "project_id" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "directive_id" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "org_inbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "org_id" of relation "org_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "dept_slug" of relation "org_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "org_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "org_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "org_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "org_id" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "dept_slug" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "message_id" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "msg_from" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "msg_to" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "subject" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ref_id" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "project_id" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "directive_id" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "org_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "org_id" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "project_id" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "slug" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "vertical" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "org_projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "install_slug" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "target_role" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "due_at" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "consumed_at" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "consumed_by" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source_id" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "pending_events" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "phase" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "review_id" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "resolved" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mtime_ms" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "pending_reviews" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "pi_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "session_id" of relation "pi_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "bearer_hash" of relation "pi_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "capabilities" of relation "pi_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "pi_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ended_at" of relation "pi_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plan_slug" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "seq" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content_hash" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content_snapshot" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "rationale" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author_kind" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author_id" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "session_id" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "session_kind" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "plan_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plan_run_id" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "seq" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tokens_in" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tokens_out" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_usd" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "plan_run_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plan_slug" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plan_content_hash" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "session_id" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "note" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "launched_by" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "launched_at" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "plan_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_name" of relation "plugin_capability_grants" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_version" of relation "plugin_capability_grants" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "plugin_capability_grants" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "capability" of relation "plugin_capability_grants" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "granted_at" of relation "plugin_capability_grants" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "granted_by" of relation "plugin_capability_grants" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "reason" of relation "plugin_capability_grants" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "plugin_configs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_slug" of relation "plugin_configs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "config" of relation "plugin_configs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "plugin_configs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "plugin_configs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "config_ct" of relation "plugin_configs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "plugin_enables" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_slug" of relation "plugin_enables" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "version" of relation "plugin_enables" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "config_hash" of relation "plugin_enables" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "enabled_at" of relation "plugin_enables" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "plugin_enables" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "plugin_enables" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_id" of relation "plugin_kv" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "plugin_kv" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "key" of relation "plugin_kv" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "value" of relation "plugin_kv" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "byte_size" of relation "plugin_kv" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "plugin_kv" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_id" of relation "plugin_reload_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "plugin_reload_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "state" of relation "plugin_reload_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "byte_size" of relation "plugin_reload_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "saved_at" of relation "plugin_reload_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "auth_session_id" of relation "power_user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "power_user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_id" of relation "power_user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "power_user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_seen_at" of relation "power_user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "revoked_at" of relation "power_user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "head_sha" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "check_name" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "conclusion" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "details_url" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "fetched_at" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "raw" of relation "pr_check_status_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "pr_reviewer_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "pr_reviewer_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_user_id" of relation "pr_reviewer_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "pr_reviewer_role_enabled" of relation "pr_reviewer_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "auto_review" of relation "pr_reviewer_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "auto_merge" of relation "pr_reviewer_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "merge_method" of relation "pr_reviewer_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "pr_reviewer_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "project_id" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spec" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "summary" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author_role" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "include_decisions" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tokens_in" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tokens_out" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_usd_cents" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "project_spec_revisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "slug" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "budget_cents" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spent_cents" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cost_cap_cents" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "earned_cents" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "owning_dept" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "vertical" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_ts" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spec" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spec_updated_at" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spec_manually_edited_at" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parent_slug" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "_search" of relation "projects" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts_ms" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "total_chars" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "substrate_chars" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "history_chars" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role_prompt_chars" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "memory_chars" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "identity_chars" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "runtime_chars" of relation "prompt_compositions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "provision_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "provision_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "provision_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_slug" of relation "provision_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "provision_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "provision_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "provision_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "data" of relation "provision_audit_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "provision_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "provision_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_slug" of relation "provision_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "provision_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "provision_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "method" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "path" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "principal_kind" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "principal_auth_method" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "principal_trust" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_message" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "invoked_at" of relation "route_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "install_slug" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trigger_kind" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trigger_config" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "target_role" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload_template" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "concurrency" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "catchup" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "active" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_fired_at" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "next_fire_at" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "routines" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "description" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "arg_hint" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "saved_prompts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "schema_migrations" already exists, skipping',
  file: 'parse_utilcmd.c',
  line: '211',
  routine: 'transformCreateStmt'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "filename" of relation "schema_migrations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "applied_at" of relation "schema_migrations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "sha256" of relation "schema_migrations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "setup_wizard_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "setup_wizard_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "setup_wizard_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_user_id" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "machine_label" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "device_pubkey" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "intent" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "current_view" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_seen_at" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "schema_version" of relation "shared_presence" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "provider" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_repository_id" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "github_full_name" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_topic" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_link" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "privacy" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claim_status" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "provisional_owner_github_user_id" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "provisional_owner_github_login" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimed_by_github_user_ids" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimed_at" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_permission_verified_at" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "superseded_by_harness_topic" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cached_at" of relation "shared_repo_binding_cache" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "snapshot_id" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "summary" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "attempts" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claims" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "notes" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "project_id" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expected_cost_cents" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tags" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "needs_human_review" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "deprecation_reason" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parent_id" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "goal_id" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_ts" of relation "snapshot_features" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "reason" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimed_role" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimed_harness" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimed_workspace" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "claimed_spawn" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "exp_claim" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "remote_addr" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_agent" of relation "spawn_sig_verification_failures" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spawn_id" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parent_spawn_id" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parent_role" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "child_role" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "chunk_id" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "finished_at" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "exit_code" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "output_tail" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_message" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cancel_requested" of relation "spawned_agents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "substrate_meta" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "substrate_meta" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "key" of relation "substrate_meta" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "value" of relation "substrate_meta" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "table_name" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "op" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "key" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "row" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "drained_at" of relation "substrate_outbox" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "system_principals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name" of relation "system_principals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "bearer_hash" of relation "system_principals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "capabilities" of relation "system_principals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "system_principals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "telemetry_reports" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "telemetry_reports" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "telemetry_reports" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "telemetry_reports_archive" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "telemetry_reports_archive" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "received_at" of relation "telemetry_reports_archive" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "telemetry_reports_archive" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "app_version" of relation "telemetry_reports_archive" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "os" of relation "telemetry_reports_archive" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "telemetry_reports_archive" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "forwarded_at" of relation "telemetry_reports_archive" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "file_path" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "framework" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "finished_at" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "output_tail" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "suite_id" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_group_id" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "branch" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "commit_sha" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "test_runs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "toast_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "level" of relation "toast_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "message" of relation "toast_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "description" of relation "toast_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "toast_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "toast_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "action_label" of relation "toast_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "action_href" of relation "toast_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "token" of relation "token_index" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "token_index" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "token_index" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "token_index" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "token_index" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "principal_slug" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tool" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "action" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "resource_type" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "resource_id" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "decision" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "gate" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "reason" of relation "tool_authz_log" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "plugin_name" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "tool_name" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "role" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "feature_id" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "chunk_id" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "run_id" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "spawn_id" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "parent_spawn_id" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "window_key" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "invoked_at" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_ms" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "output_ref" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "output_size" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_message" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "args_json" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "transport" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "event_count" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata_json" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "principal_kind" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "principal_auth_method" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "principal_trust" of relation "tool_invocations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "trusted_authors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "trusted_authors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trusted_github_user_id" of relation "trusted_authors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trusted_by_github_user_id" of relation "trusted_authors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "trusted_at" of relation "trusted_authors" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "client_id" of relation "ui_clients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "ui_clients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "url" of relation "ui_clients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "ui_clients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "viewport" of relation "ui_clients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "opened_at" of relation "ui_clients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_seen_at" of relation "ui_clients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "client_id" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "intent" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "args" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "result" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_message" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "requested_by" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "completed_at" of relation "ui_intents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "summary" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "detail_url" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_text" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "invocation_id" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "started_at" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "finished_at" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "actor" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "user_actions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_id" of relation "user_preferences" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "user_preferences" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "user_preferences" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "token" of relation "user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_id" of relation "user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at" of relation "user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_seen_at" of relation "user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "user_agent" of relation "user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "remote_addr" of relation "user_sessions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "users" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "username" of relation "users" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "display_name" of relation "users" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "password_hash" of relation "users" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "users" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "last_login_at" of relation "users" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "is_active" of relation "users" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "voice_lease" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "owner_id" of relation "voice_lease" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "owner_kind" of relation "voice_lease" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at_ms" of relation "voice_lease" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "source" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mode" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "length_chars" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "name_used" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "had_backstory" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "modifications" of relation "voice_utterances" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "target_url" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "event_kind" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status_code" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "attempt_count" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "sent_at" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error" of relation "webhook_audit" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "enabled" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cadence_mode" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "cadence_minutes" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "retention_preset" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "retention_custom_json" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "event_triggers_json" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "excluded_paths_json" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "destination_type" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "destination_config_encrypted" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "workspace_backup_settings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "quarter" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "script_path" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "duration_seconds" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "youtube_url" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "youtube_video_id" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "thumbnail_url" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "render_log" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "summary" of relation "briefings" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "directive_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "directive_id" of relation "directive_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "directive_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author" of relation "directive_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "directive_summaries" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "message_comments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "message_id" of relation "message_comments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "message_comments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "author" of relation "message_comments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "message_comments" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "message_id" of relation "message_recipients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "dept_slug" of relation "message_recipients" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "id" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ts" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "from_dept" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "subject" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "ref_id" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "project_id" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "directive_id" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "status" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "metadata" of relation "messages" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "adv_sessions_workspace_isolation" for relation "harness_shared.adv_sessions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "agent_chats_consolidated_workspace_isolation" for relation "harness_shared.agent_chats_consolidated" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "audit_log_workspace_isolation" for relation "harness_shared.audit_log" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "chunk_plans_workspace_isolation" for relation "harness_shared.harness_chunk_plans" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "feature_audit_consolidated_workspace_isolation" for relation "harness_shared.feature_audit_consolidated" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "goals_workspace_isolation" for relation "harness_shared.goals" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_brainstorm_workspace_isolation" for relation "harness_shared.harness_brainstorm" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_dock_layouts_workspace_isolation" for relation "harness_shared.harness_dock_layouts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_escalations_workspace_isolation" for relation "harness_shared.harness_escalations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_experts_workspace_isolation" for relation "harness_shared.harness_experts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_feature_notes_workspace_isolation" for relation "harness_shared.harness_feature_notes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_features_consolidated_workspace_isolation" for relation "harness_shared.harness_features_consolidated" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_generator_items_workspace_isolation" for relation "harness_shared.harness_generator_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_pending_issues_workspace_isolation" for relation "harness_shared.harness_pending_issues" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_phase_last_used_workspace_isolation" for relation "harness_shared.harness_phase_last_used" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_phases_workspace_isolation" for relation "harness_shared.harness_phases" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_plan_assertions_workspace_isolation" for relation "harness_shared.harness_plan_assertions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_plan_status_workspace_isolation" for relation "harness_shared.harness_plan_status" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_project_files_workspace_isolation" for relation "harness_shared.harness_project_files" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_prompt_overrides_workspace_isolation" for relation "harness_shared.harness_prompt_overrides" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_proposals_shared_workspace_isolation" for relation "harness_shared.harness_proposals_shared" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_registry_workspace_isolation" for relation "harness_shared.harness_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_skills_workspace_isolation" for relation "harness_shared.harness_skills" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_summaries_workspace_isolation" for relation "harness_shared.harness_summaries" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_tests_workspace_isolation" for relation "harness_shared.harness_tests" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_text_artifacts_workspace_isolation" for relation "harness_shared.harness_text_artifacts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hidden_plugins_workspace_isolation" for relation "harness_shared.hidden_plugins" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "identity_files_workspace_isolation" for relation "harness_shared.identity_files" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "memory_feedback_workspace_isolation" for relation "harness_shared.memory_feedback" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "mobile_devices_workspace_policy" for relation "harness_shared.mobile_devices" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "mobile_pair_tokens_workspace_isolation" for relation "harness_shared.mobile_pair_tokens" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "mobile_push_tokens_workspace_policy" for relation "harness_shared.mobile_push_tokens" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_agent_config_workspace_isolation" for relation "harness_shared.operator_agent_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_budget_workspace_isolation" for relation "harness_shared.operator_budget" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_claims_workspace_isolation" for relation "harness_shared.operator_claims" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_credentials_workspace_isolation" for relation "harness_shared.operator_credentials" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_dismissed_cards_workspace_iso" for relation "harness_shared.operator_dismissed_cards" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_first_run_workspace_isolation" for relation "harness_shared.operator_first_run" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_idle_snapshot_workspace_isolation" for relation "harness_shared.operator_idle_snapshot" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_last_scan_workspace_isolation" for relation "harness_shared.operator_last_scan" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_marketplace_token_workspace_isolation" for relation "harness_shared.operator_marketplace_token" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_oracle_memory_workspace_isolation" for relation "harness_shared.operator_oracle_memory" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_oracle_prompt_workspace_isolation" for relation "harness_shared.operator_oracle_prompt" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_paused_workspace_isolation" for relation "harness_shared.operator_paused" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_preferences_workspace_isolation" for relation "harness_shared.operator_preferences" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_prompt_user_workspace_isolation" for relation "harness_shared.operator_prompt_user" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_publish_credentials_workspace_isolation" for relation "harness_shared.operator_publish_credentials" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_rate_limit_workspace_isolation" for relation "harness_shared.operator_rate_limit" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_scan_locks_workspace_iso" for relation "harness_shared.operator_scan_locks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_scanner_session_workspace_isolation" for relation "harness_shared.operator_scanner_session" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_standing_candidates_workspace_isolation" for relation "harness_shared.operator_standing_candidates" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_stt_spend_workspace_isolation" for relation "harness_shared.operator_stt_spend" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_trust_store_workspace_isolation" for relation "harness_shared.operator_trust_store" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_tts_spend_workspace_isolation" for relation "harness_shared.operator_tts_spend" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_user_profile_workspace_isolation" for relation "harness_shared.operator_user_profile" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_voice_credentials_workspace_isolation" for relation "harness_shared.operator_voice_credentials" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_voice_prefs_workspace_isolation" for relation "harness_shared.operator_voice_prefs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "org_charter_workspace_isolation" for relation "harness_shared.org_charter" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "org_decisions_workspace_isolation" for relation "harness_shared.org_decisions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "org_departments_workspace_isolation" for relation "harness_shared.org_departments" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "org_inbox_workspace_isolation" for relation "harness_shared.org_inbox" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "org_notes_workspace_isolation" for relation "harness_shared.org_notes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "org_outbox_workspace_isolation" for relation "harness_shared.org_outbox" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "org_projects_workspace_isolation" for relation "harness_shared.org_projects" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "osc_workspace_isolation" for relation "harness_shared.operator_search_provider_credentials" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "pending_events_workspace_isolation" for relation "harness_shared.pending_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "pending_reviews_workspace_isolation" for relation "harness_shared.pending_reviews" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "pi_sessions_workspace_isolation" for relation "harness_shared.pi_sessions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plugin_configs_workspace_isolation" for relation "harness_shared.plugin_configs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plugin_enables_workspace_isolation" for relation "harness_shared.plugin_enables" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "project_spec_revisions_workspace_isolation" for relation "harness_shared.project_spec_revisions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "projects_workspace_isolation" for relation "harness_shared.projects" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "prompt_compositions_workspace_isolation" for relation "harness_shared.prompt_compositions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "provision_audit_log_workspace_isolation" for relation "harness_shared.provision_audit_log" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "provision_state_workspace_isolation" for relation "harness_shared.provision_state" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "route_invocations_workspace_isolation" for relation "harness_shared.route_invocations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "routines_workspace_isolation" for relation "harness_shared.routines" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "saved_prompts_workspace_isolation" for relation "harness_shared.saved_prompts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "setup_wizard_state_workspace_isolation" for relation "harness_shared.setup_wizard_state" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "spawned_agents_workspace_isolation" for relation "harness_shared.spawned_agents" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "system_principals_workspace_isolation" for relation "harness_shared.system_principals" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "telemetry_reports_archive_workspace_isolation" for relation "harness_shared.telemetry_reports_archive" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "telemetry_reports_workspace_isolation" for relation "harness_shared.telemetry_reports" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "token_index_workspace_isolation" for relation "harness_shared.token_index" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "tool_authz_log_workspace_isolation" for relation "harness_shared.tool_authz_log" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "tool_invocations_workspace_isolation" for relation "harness_shared.tool_invocations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "voice_lease_workspace_isolation" for relation "harness_shared.voice_lease" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 107-dogfood-reactivity-triggers.sql
[with-test-pg] pg apply 108-substrate-capture-reconcile.sql
[with-test-pg] pg apply 109-global-schemas-and-grants.sql
[with-test-pg] pg apply 110-harness-gym-control-plane.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_proposals_workspace_isolation" for relation "harness_shared.gym_proposals" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_autoloop_config_workspace_isolation" for relation "harness_shared.gym_autoloop_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 111-agent-rate-budget.sql
[with-test-pg] pg apply 112-drop-operator-claims.sql
[with-test-pg] pg apply 113-reconcile-stale-token-index-slug-constraint.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "token_index_harness_slug_key" of relation "token_index" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'index "token_index_harness_slug_key" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "token_index_ws_harness_slug_idx" already exists, skipping',
  file: 'index.c',
  line: '894',
  routine: 'index_create'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "projects_slug_key" of relation "projects" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'index "projects_slug_idx" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "projects_ws_slug_idx" already exists, skipping',
  file: 'index.c',
  line: '894',
  routine: 'index_create'
}
[with-test-pg] pg apply 114-substrate-capture-restore-update-guard.sql
[with-test-pg] pg apply 115-adv-session-native-id.sql
[with-test-pg] pg apply 116-consolidate-agent-chats.sql
[with-test-pg] pg pg: 2026-10-25 15:05:51.973 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:51.974 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 117-drop-experts-tables.sql
[with-test-pg] pg apply 118-consolidate-feature-audit.sql
[with-test-pg] pg pg: 2026-10-25 15:05:51.982 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:51.983 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 119-consolidate-supervisor-notes-directive-summaries.sql
[with-test-pg] pg pg: 2026-10-25 15:05:51.988 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:51.994 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 120-consolidate-messages-executed-actions.sql
[with-test-pg] pg pg: 2026-10-25 15:05:51.996 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.002 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 121-retire-per-harness-config-token-and-proposals.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.003 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.004 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 122-harness-plans.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.005 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "harness_plans_updated_at_trg" for relation "harness_shared.harness_plans" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_plans_workspace_isolation" for relation "harness_shared.harness_plans" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.011 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 123-coordination-substrate.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.013 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.035 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 124-harness-plans-change-notify.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.037 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.037 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 125-harness-plans-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.039 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.039 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 126-coordination-fanout.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.041 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "coord_event_log_notify_trg" for relation "harness_shared.coord_event_log" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.042 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 127-drop-coord-subscriptions.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.043 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.045 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 128-harness-plans-normalize.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.046 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.047 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 130-harness-issues-enums-canonical.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.048 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'function harness_shared.sync_issues_consolidated() does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.051 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 131-engineer-issues.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.056 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "engineer_issues_updated_at_trg" for relation "harness_shared.engineer_issues" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.062 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 132-coordination-conversations.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.064 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.067 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 133-harness-blueprints.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.069 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "blueprints_workspace_isolation" for relation "harness_shared.blueprints" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.072 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 134-snapshot-index.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.074 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "snapshot_index_workspace_isolation" for relation "harness_shared.snapshot_index" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.082 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 135-migration-reservations.sql
[with-test-pg] pg apply 136-work-items-generalization.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.086 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.090 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 137-plugin-audit-log.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.092 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.097 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 138-tui-workbench-state.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.098 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "tui_layouts_workspace_isolation" for relation "harness_shared.tui_layouts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "tui_crews_workspace_isolation" for relation "harness_shared.tui_crews" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "tui_view_state_workspace_isolation" for relation "harness_shared.tui_view_state" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.110 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 139-tui-intents.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.111 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.114 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 140-plan-item-assignments.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.115 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "plan_item_assignments_updated_at_trg" for relation "harness_shared.plan_item_assignments" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "agent_names_updated_at_trg" for relation "harness_shared.agent_names" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.135 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 141-plan-item-claims.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.137 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.141 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 142-work-items-unify.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.142 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "engineer_issues_kind_chk" of relation "engineer_issues" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.145 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 143-agent-activity.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.146 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "agent_activity_notify_trg" for relation "harness_shared.agent_activity" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.149 EDT [3319074] WARNING:  there is no transaction in progress

[with-test-pg] pg apply 144-coord-conversations-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.151 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.153 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 145-plan-item-assignments-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.154 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.154 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 146-fleet-supervision.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.155 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.158 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 147-fleet-governor.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.160 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.162 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 148-fleet-sagas.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.163 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.167 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 149-coord-threads-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.168 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.171 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 150-coord-event-log-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.173 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.175 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 151-operator-curation.sql
[with-test-pg] pg apply 152-delegate-task-workitems.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.181 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.186 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 153-event-reaction-dedup.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.188 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.190 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 154-rationale-index.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.191 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.193 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 155-drop-feature-blocked-by-column.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.195 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'column "blocked_by" of relation "harness_features_consolidated" does not exist, skipping',
  file: 'tablecmds.c',
  line: '9328',
  routine: 'ATExecDropColumn'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'index "hfc_blocked_by_gin_idx" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.198 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 156-drain-mem0-retired-scopes.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.200 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.203 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 157-improvement-kind-backfill.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.203 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.204 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 158-pot-wake-state.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "pot_wake_workspace_isolation" for relation "harness_shared.pot_wake" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 159-work-items-union-view.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.210 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_items_dml_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.221 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 160-operator-turns-report-column.sql
[with-test-pg] pg apply 161-operator-rate-limit-config-and-usage-samples.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_rate_limit_config_workspace_isolation" for relation "harness_shared.operator_rate_limit_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "agent_usage_samples_workspace_isolation" for relation "harness_shared.agent_usage_samples" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 162-attention-triage.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "attention_triage_workspace_isolation" for relation "harness_shared.attention_triage" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 163-await-event-subscriptions.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "event_awaits_workspace_isolation" for relation "harness_shared.event_awaits" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "event_wake_deliveries_workspace_isolation" for relation "harness_shared.event_wake_deliveries" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 164-voice-channels-state.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_voice_channels_workspace_isolation" for relation "harness_shared.operator_voice_channels" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 165-fleet-assignment-view-and-change-feed.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.253 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "engineer_issues_assignee_idx" already exists, skipping',
  file: 'index.c',
  line: '894',
  routine: 'index_create'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_presence_ins_del_trg" for relation "harness_shared.coord_presence" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_presence_upd_trg" for relation "harness_shared.coord_presence" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_claims_ins_del_trg" for relation "harness_shared.plan_item_claims" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_claims_upd_trg" for relation "harness_shared.plan_item_claims" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_assign_ins_del_trg" for relation "harness_shared.plan_item_assignments" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_assign_upd_trg" for relation "harness_shared.plan_item_assignments" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_features_ins_trg" for relation "harness_shared.harness_features_consolidated" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_features_upd_trg" for relation "harness_shared.harness_features_consolidated" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_issues_ins_trg" for relation "harness_shared.engineer_issues" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fleet_assignment_issues_upd_trg" for relation "harness_shared.engineer_issues" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.262 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 166-voice-lease-tui-kind.sql
[with-test-pg] pg apply 167-drop-operator-scanner-tables.sql
[with-test-pg] pg apply 168-operator-conversation-summary.sql
[with-test-pg] pg apply 169-operator-turns-report-partial-index.sql
[with-test-pg] pg apply 170-cross-backend-usage-attribution.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.279 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.283 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 171-drop-harness-health-tombstone.sql
[with-test-pg] pg apply 172-harness-docs.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.286 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "harness_docs_updated_at_trg" for relation "harness_shared.harness_docs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_docs_workspace_isolation" for relation "harness_shared.harness_docs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.290 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 173-adv-session-workbench-display.sql
[with-test-pg] pg apply 174-spawned-agents-heartbeat-reclaim.sql
[with-test-pg] pg apply 175-watch-floor-coalesce-cols.sql
[with-test-pg] pg apply 176-harness-app-sequence-grants.sql
[with-test-pg] pg apply 177-pipeline-events.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.303 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "pipeline_events_workspace_isolation" for relation "harness_shared.pipeline_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.308 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 178-work-item-assignee-rank.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.310 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.323 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 179-iq-battery-corpus.sql
[with-test-pg] pg apply 180-beekeeper-runner.sql
[with-test-pg] pg apply 181-hyperbee-projection-fed-ts-guard.sql
[with-test-pg] pg apply 182-hive-directory-cache.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_directory_cache_workspace_isolation" for relation "harness_shared.hive_directory_cache" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 183-event-awaits-inbox-wake-one-per-agent.sql
[with-test-pg] pg apply 184-hives-table.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hives_workspace_isolation" for relation "harness_shared.hives" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 185-hive-members-admission.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_members_workspace_isolation" for relation "harness_shared.hive_members" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 186-hive-settings.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.367 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_settings_workspace_isolation" for relation "harness_shared.hive_settings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.370 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 187-shared-presence-hive-slug.sql
[with-test-pg] pg apply 188-work-item-claims.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.372 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.377 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 189-hive-members-federation-cols.sql
[with-test-pg] pg apply 190-operator-account-pool.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_account_pool_workspace_isolation" for relation "harness_shared.operator_account_pool" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 191-work-item-swarm-affinity.sql
[with-test-pg] pg apply 192-drop-org-sim-tables.sql
[with-test-pg] pg apply 193-gym-qd-archive.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_qd_archive_workspace_isolation" for relation "harness_shared.gym_qd_archive" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 194-scout-routed-ideas.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "scout_routed_ideas_workspace_isolation" for relation "harness_shared.scout_routed_ideas" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 195-work-item-redundancy.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.414 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.419 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 196-cross-hive-outbox.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.421 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.425 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 197-engineer-issues-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.426 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.427 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 198-rename-pot-wake-to-hive-wake.sql
[with-test-pg] pg apply 199-drop-snapshot-index.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.440 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.443 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 200-drop-orphan-tables.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.451 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "harness_expert_feedback" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "harness_expert_turns" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "harness_experts" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "delegate_inbox" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "delegates" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "operator_claims" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "coord_subscriptions" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.455 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 201-beekeeper-scores-fractional-metrics.sql
[with-test-pg] pg apply 202-watchdog-ticks.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "watchdog_ticks_workspace_isolation" for relation "harness_shared.watchdog_ticks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 203-spawned-agents-session-id.sql
[with-test-pg] pg apply 204-pending-wakes.sql
[with-test-pg] pg apply 205-tool-invocations-error-code.sql
[with-test-pg] pg apply 206-watchdog-ticks-deferred-keys.sql
[with-test-pg] pg apply 207-watchdog-key-dedup.sql
[with-test-pg] pg apply 208-scout-ticks-and-lens-weights.sql
[with-test-pg] pg apply 210-usage-cache-creation-and-interactive-ingest.sql
[with-test-pg] pg apply 211-harness-plans-updated-at-guard.sql
[with-test-pg] pg apply 212-hive-watchdog-fires.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_watchdog_fires_workspace_isolation" for relation "harness_shared.hive_watchdog_fires" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 213-spawned-agents-outcome-reactivity.sql
[with-test-pg] pg apply 214-federated-fed-ts-local-stamp.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.harness_plans" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.harness_plans"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.harness_features_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.harness_features_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.harness_issues_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.harness_issues_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.coord_event_log" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.coord_event_log"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.coord_conversations" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.coord_conversations"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.coord_threads" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.coord_threads"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.coord_thread_posts" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.coord_thread_posts"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.plan_item_assignments" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.plan_item_assignments"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.hive_settings" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.hive_settings"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.hive_members" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.hive_members"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.engineer_issues" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.engineer_issues"\n' +
    'PL/pgSQL function inline_code_block line 18 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 215-engineer-issues-reactivity.sql
[with-test-pg] pg apply 216-operator-flag-overrides.sql
[with-test-pg] pg apply 217-beekeeper-repeats-and-gen0-uniqueness.sql
[with-test-pg] pg apply 218-plan-revisions-workspace-scope.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_revisions_workspace_isolation" for relation "harness_shared.plan_revisions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 219-spawned-agents-idempotency-key.sql
[with-test-pg] pg apply 220-mcp-tool-result-replay.sql
[with-test-pg] pg apply 221-backfill-text-artifacts-workspace-id.sql
[with-test-pg] pg apply 222-harness-registry-change-notify.sql
[with-test-pg] pg apply 223-voice-relay-state.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "voice_relay_workspace_isolation" for relation "harness_shared.voice_relay" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 224-pending-wakes-coalesce.sql
[with-test-pg] pg apply 225-fleet-assignment-nursery-alias-liveness.sql
[with-test-pg] pg apply 226-papercup-directives-baseline-gap.sql
[with-test-pg] pg apply 227-agent-chats-consolidated-change-notify.sql
[with-test-pg] pg apply 228-spawned-agents-pid-host.sql
[with-test-pg] pg apply 229-spawned-agents-model-tier.sql
[with-test-pg] pg apply 230-spawned-agents-brief.sql
[with-test-pg] pg apply 231-cross-hive-asks.sql
[with-test-pg] pg apply 232-steering-churn.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "record_steering_churn_trg" for relation "harness_shared.harness_features_consolidated" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "steering_churn_events_workspace_isolation" for relation "harness_shared.steering_churn_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "steering_churn_escalations_workspace_isolation" for relation "harness_shared.steering_churn_escalations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 233-spawned-agents-last-output.sql
[with-test-pg] pg apply 234-scout-idea-grading.sql
[with-test-pg] pg apply 235-cross-hive-asks-asked-by.sql
[with-test-pg] pg apply 236-cross-hive-beacon-history.sql
[with-test-pg] pg apply 237-git-sync-degeneralize-data.sql
[with-test-pg] pg apply 238-improvement-dispatches-ledger.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "improvement_dispatches_workspace_isolation" for relation "harness_shared.improvement_dispatches" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 239-learning-pack-candidates.sql
[with-test-pg] pg apply 240-memory-recall-stats.sql
[with-test-pg] pg apply 241-signal-provenance-origin.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "engineer_issues_signal_origin_chk" of relation "engineer_issues" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 242-behavior-change-ledger.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "behavior_change_ledger_workspace_isolation" for relation "harness_shared.behavior_change_ledger" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 243-gym-champion-outcomes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_champion_outcomes_workspace_isolation" for relation "harness_shared.gym_champion_outcomes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 244-learning-governor.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "learning_governor_loops_workspace_isolation" for relation "harness_shared.learning_governor_loops" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "learning_spend_events_workspace_isolation" for relation "harness_shared.learning_spend_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 245-negative-space-demand.sql
[with-test-pg] pg apply 246-behavior-change-ledger-append-only.sql
[with-test-pg] pg apply 247-replay-runs.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "replay_runs_workspace_isolation" for relation "harness_shared.replay_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 248-regret-findings.sql
[with-test-pg] pg apply 249-prompt-ablation-runs.sql
[with-test-pg] pg apply 250-transfer-lessons.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "transfer_lessons_workspace_isolation" for relation "harness_shared.transfer_lessons" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 251-fleet-ekg.sql
[with-test-pg] pg apply 252-deferral-pricing-model.sql
[with-test-pg] pg apply 253-calibration-predictions.sql
[with-test-pg] pg apply 254-owner-interactions.sql
[with-test-pg] pg apply 255-red-queen-drills.sql
[with-test-pg] pg apply 257-fleet-assignment-routine-not-orphaned.sql
[with-test-pg] pg apply 258-drop-harness-git-log-mirror.sql
[with-test-pg] pg apply 259-autonomy-policy.sql
[with-test-pg] pg apply 260-decision-ledger.sql
[with-test-pg] pg apply 261-hive-throughput-ticks.sql
[with-test-pg] pg apply 262-risk-tier-authority-schema.sql
[with-test-pg] pg apply 263-hive-placements.sql
[with-test-pg] pg apply 264-hive-eval-battery.sql
[with-test-pg] pg apply 265-decision-ledger-disposition.sql
[with-test-pg] pg apply 266-autonomy-tripwires.sql
[with-test-pg] pg apply 267-retire-plan-review.sql
[with-test-pg] pg apply 268-hive-eval-scores.sql
[with-test-pg] pg apply 269-autonomy-tripwire-decision-id.sql
[with-test-pg] pg apply 270-harness-plan-parts.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "harness_plan_parts_workspace_isolation" for relation "harness_shared.harness_plan_parts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 271-harness-plan-parts-capture.sql
[with-test-pg] pg apply 272-agent-usage-turn-count.sql
[with-test-pg] pg apply 273-verified-author-github-id.sql
[with-test-pg] pg apply 274-autonomy-policy-vocab-never-auto.sql
[with-test-pg] pg apply 275-coord-event-log-sync-invalidate.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.coord_event_log" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 276-user-trust-list.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "user_trust_list_workspace_isolation" for relation "harness_shared.user_trust_list" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 277-coord-presence-v2-columns.sql
[with-test-pg] pg apply 278-hive-member-repo-permission-cache.sql
[with-test-pg] pg apply 279-agent-usage-samples-session-id.sql
[with-test-pg] pg apply 281-work-item-checkpoints.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "work_item_checkpoints_workspace_isolation" for relation "harness_shared.work_item_checkpoints" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 282-drop-harness-summaries-mirror.sql
[with-test-pg] pg apply 283-drop-harness-branch-actions-mirror.sql
[with-test-pg] pg apply 284-harness-plans-initiative.sql
[with-test-pg] pg apply 285-drop-harness-phases-mirror.sql
[with-test-pg] pg apply 286-slot-parked-messages.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "slot_parked_messages_workspace_isolation" for relation "harness_shared.slot_parked_messages" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 287-experiment-runs-ledger.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "experiment_runs_workspace_isolation" for relation "harness_shared.experiment_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 289-learning-loops-per-hive-scope.sql
[with-test-pg] pg apply 290-per-hive-observability-columns.sql
[with-test-pg] pg apply 291-benchmark-reproducibility.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "benchmark_prereg_workspace_isolation" for relation "harness_shared.benchmark_prereg" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "benchmark_rollout_workspace_isolation" for relation "harness_shared.benchmark_rollout" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "benchmark_run_result_workspace_isolation" for relation "harness_shared.benchmark_run_result" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 292-benchmark-hive-layer.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "benchmark_fleet_run_workspace_isolation" for relation "harness_shared.benchmark_fleet_run" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "benchmark_coord_event_workspace_isolation" for relation "harness_shared.benchmark_coord_event" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 293-hive-eval-bakeoff-deltas.sql
[with-test-pg] pg apply 294-hive-directory-tombstones.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_directory_tombstones_workspace_isolation" for relation "harness_shared.hive_directory_tombstones" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 295-wi148-workspace-identity-restamp.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "_wi148_ws_map" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
[with-test-pg] pg apply 296-bench-run-operational-store.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "bench_runs_workspace_isolation" for relation "harness_shared.bench_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "bench_run_tasks_workspace_isolation" for relation "harness_shared.bench_run_tasks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "bench_run_events_workspace_isolation" for relation "harness_shared.bench_run_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 297-operator-account-override.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_account_override_workspace_isolation" for relation "harness_shared.operator_account_override" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 298-bench-run-infra-excluded.sql
[with-test-pg] pg apply 299-scheduled-plans-schedule-fields.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.856 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.862 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 300-scheduled-plans-run-rollup-index.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.863 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.864 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 301-usage-events-workspace-id-fill-trigger.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fill_ws_usage_trg" for relation "harness_shared.contributor_usage_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 302-bench-run-score.sql
[with-test-pg] pg apply 303-plan-runs-workspace-isolation.sql
[with-test-pg] pg apply 304-user-preferences-per-workspace.sql
[with-test-pg] pg apply 305-routines-workspace-unique.sql
[with-test-pg] pg apply 306-harness-features-consolidated-schedule-fields.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.879 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "expires_at" of relation "harness_features_consolidated" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.880 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 307-harness-features-requeue-count.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.882 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.883 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 308-periodic-sweep-runs.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.884 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.886 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 309-projects-ephemeral-flag.sql
[with-test-pg] pg apply 311-pending-wakes-workspace-idx.sql
[with-test-pg] pg apply 312-memory-precision-bench.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.892 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "memory_precision_bench_workspace_isolation" for relation "harness_shared.memory_precision_bench" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.895 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 313-memory-archived-state.sql
[with-test-pg] pg apply 314-d001-hlc-ordering-key.sql
[with-test-pg] pg apply 315-tool-invocations-invoked-at-cov-idx.sql
[with-test-pg] pg apply 316-hive-epoch-keys.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_epoch_keys_workspace_isolation" for relation "harness_shared.hive_epoch_keys" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 317-hive-policy.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.912 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_policy_workspace_isolation" for relation "harness_shared.hive_policy" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.hive_policy" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.916 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 318-en3-membership-moderation-tables.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_pending_joins_workspace_isolation" for relation "harness_shared.hive_pending_joins" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hive_reports_workspace_isolation" for relation "harness_shared.hive_reports" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 319-pr-review-reports.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "pr_review_reports_workspace_isolation" for relation "harness_shared.pr_review_reports" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 320-autovacuum-high-churn-telemetry.sql
[with-test-pg] pg apply 321-pr4-feature-pr-producer-identity.sql
[with-test-pg] pg apply 322-session-briefs-ei1742.sql
[with-test-pg] pg apply 323-loop-routines-reschedule-interval.sql
[with-test-pg] pg apply 325-observation-schema-v2.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.943 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.949 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 326-rubrics-store.sql
[with-test-pg] pg apply 327-seed-hive-coordination-health-rubric.sql
[with-test-pg] pg apply 328-hive-placements-infra-loss-count.sql
[with-test-pg] pg apply 329-plan-template-mechanism.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "harness_plans_template_idx" already exists, skipping',
  file: 'index.c',
  line: '894',
  routine: 'index_create'
}
[with-test-pg] pg apply 330-agent-usage-plan-tool-attribution.sql
[with-test-pg] pg apply 331-harness-plans-promote-policy-column.sql
[with-test-pg] pg apply 332-rename-papercup-shared-to-papercusp-shared.sql
[with-test-pg] pg apply 333-scout-routed-ideas-source-target-hive.sql
[with-test-pg] pg pg: 2026-10-25 15:05:52.980 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:52.982 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 334-model-pricing-snapshot-table.sql
[with-test-pg] pg apply 335-agent-usage-turn-trigger.sql
[with-test-pg] pg apply 337-operator-migrate-policy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_migrate_policy_workspace_isolation" for relation "harness_shared.operator_migrate_policy" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 338-migrate-hive-coordination-health-rubric-to-plan.sql
[with-test-pg] pg apply 339-spawned-agents-launcher-boot-id.sql
[with-test-pg] pg apply 340-role-capability-grants.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "role_capability_grants_workspace_isolation" for relation "harness_shared.role_capability_grants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 341-operator-opus-budget-policy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_opus_budget_policy_workspace_isolation" for relation "harness_shared.operator_opus_budget_policy" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 342-operator-scale-policy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_scale_policy_workspace_isolation" for relation "harness_shared.operator_scale_policy" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 346-operator-auto-implement-policy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_auto_implement_policy_workspace_isolation" for relation "harness_shared.operator_auto_implement_policy" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 347-operator-gym-gates.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_gym_gates_workspace_isolation" for relation "harness_shared.operator_gym_gates" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 348-operator-coord-liveness-config.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_coord_liveness_config_workspace_isolation" for relation "harness_shared.operator_coord_liveness_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 349-code-recipes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "code_recipes_workspace_isolation" for relation "harness_shared.code_recipes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "code_recipe_runs_workspace_isolation" for relation "harness_shared.code_recipe_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 350-operator-hive-control-policy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_hive_control_policy_workspace_isolation" for relation "harness_shared.operator_hive_control_policy" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 351-operator-release-checkpoint-config.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_release_checkpoint_config_workspace_isolation" for relation "harness_shared.operator_release_checkpoint_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 352-operator-capability-envelopes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_capability_envelopes_workspace_isolation" for relation "harness_shared.operator_capability_envelopes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 353-drop-v1-rubrics-table.sql
[with-test-pg] pg apply 354-operator-telemetry-buffer-config.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_telemetry_buffer_config_workspace_isolation" for relation "harness_shared.operator_telemetry_buffer_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 355-coord-open-escalations-projection.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "coord_open_escalations_trg" for relation "harness_shared.coord_event_log" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 356-operator-txn-timeouts-config.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_txn_timeouts_config_workspace_isolation" for relation "harness_shared.operator_txn_timeouts_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 357-agent-usage-account-attribution.sql
[with-test-pg] pg apply 357-harness-features-last-progress-at.sql
[with-test-pg] pg apply 358-work-items-stalled-activity-views.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.072 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.083 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 359-canonicalize-federation-harness-slug.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.084 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.085 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 360-harness-docs-workspace-restamp.sql
[with-test-pg] pg apply 361-coord-plane-workspace-restamp.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'coord-restamp 361: moved events=0, watermarks=0, escalations=0 (dropped 0 stale papercusp watermark dupe(s))',
  where: 'PL/pgSQL function inline_code_block line 78 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 362-backfill-engineer-issues-harness-workspace.sql
[with-test-pg] pg apply 363-commit-attribution-ledger.sql
[with-test-pg] pg apply 364-edit-attribution-ledger-repo-root.sql
[with-test-pg] pg apply 365-decision-ledger-autovacuum.sql
[with-test-pg] pg apply 366-coord-links-blocks-change-notify.sql
[with-test-pg] pg apply 367-work-item-deps.sql
[with-test-pg] pg apply 368-fix-emit-change-notify-guc.sql
[with-test-pg] pg apply 369-cache-l2-table.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.119 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.123 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 370-backfill-work-item-deps.sql
[with-test-pg] pg apply 371-extend-hive-coord-health-scheduler-usage.sql
[with-test-pg] pg apply 372-bee-claim-specs.sql
[with-test-pg] pg apply 373-sync-trigger-coverage.sql
[with-test-pg] pg apply 374-work-items-unify-base-table.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.146 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'drop cascades to view harness_shared.fleet_assignment',
  where: 'SQL statement "DROP VIEW harness_shared.work_items CASCADE"\n' +
    'PL/pgSQL function inline_code_block line 8 at SQL statement',
  file: 'dependency.c',
  line: '1177',
  routine: 'reportDependentObjects'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "engineer_issues_view_dml_trg" for relation "harness_shared.engineer_issues" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.162 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 375-recreate-fleet-assignment-view-dropped-by-374.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.166 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.170 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 375-work-items-cdc-capture.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.173 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.174 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 376-restore-append-heavy-exclusion-cover-bee-claim-specs.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.audit_log" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.audit_log"\n' +
    'PL/pgSQL function inline_code_block line 16 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.agent_runs_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.agent_runs_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 16 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.user_actions" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.user_actions"\n' +
    'PL/pgSQL function inline_code_block line 16 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.harness_hook_logs" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.harness_hook_logs"\n' +
    'PL/pgSQL function inline_code_block line 16 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.toast_log" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.toast_log"\n' +
    'PL/pgSQL function inline_code_block line 16 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.feature_audit_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.feature_audit_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 16 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 377-learning-pack-candidates-global.sql
[with-test-pg] pg apply 378-code-recipes-global.sql
[with-test-pg] pg apply 379-maintained-ready-column.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "wir_deps_sync_trg" for relation "harness_shared.work_item_deps" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "wir_status_sync_dependents_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "wir_insert_sync_own_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "wir_delete_cleanup_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 380-design-artifacts-change-notify.sql
[with-test-pg] pg apply 382-operator-issue-scope-removal.sql
[with-test-pg] pg apply 383-drop-dead-coord-links-blocks-trigger.sql
[with-test-pg] pg apply 384-agent-rate-budget-rpm-factor.sql
[with-test-pg] pg apply 386-harness-docs-steward-retry-attempts.sql
[with-test-pg] pg apply 387-event-wake-delivery-source.sql
[with-test-pg] pg apply 388-engineer-issues-view-dml-created-ts.sql
[with-test-pg] pg apply 389-bee-claim-spec-id-only.sql
[with-test-pg] pg apply 390-sentinel-says-pg.sql
[with-test-pg] pg apply 391-coord-plane-workspace-restamp-followup.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'coord-restamp 391 follow-up: moved events=0, watermarks=0, escalations=0 (dropped 0 stale papercusp watermark dupe(s))',
  where: 'PL/pgSQL function inline_code_block line 73 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 392-placement-infra-curse-deadlock-fix.sql
[with-test-pg] pg apply 393-operator-scout-budget.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_scout_budget_workspace_isolation" for relation "harness_shared.operator_scout_budget" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 394-operator-quota-overrides.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_quota_overrides_workspace_isolation" for relation "harness_shared.operator_quota_overrides" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 395-perf-regression-snapshots.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "perf_regression_snapshots_workspace_isolation" for relation "harness_shared.perf_regression_snapshots" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 396-coord-links-change-notify.sql
[with-test-pg] pg apply 397-worker-chunk-loop-outcomes.sql
[with-test-pg] pg apply 398-memory-canonical-promote-scope-columns.sql
[with-test-pg] pg apply 399-normalize-workspace-id-naming-telemetry.sql
[with-test-pg] pg apply 400-operator-auth-config.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_auth_config_workspace_isolation" for relation "harness_shared.operator_auth_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 401-operator-capability-tiers.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_capability_tiers_workspace_isolation" for relation "harness_shared.operator_capability_tiers" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 402-work-items-workspace-rls.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "work_items_workspace_isolation" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 403-work-items-signal-origin-restore.sql
[with-test-pg] pg apply 404-hive-scope-existing-plans.sql
[with-test-pg] pg apply 406-hive-members-forbid-wildcard-workspace.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "hive_members_workspace_id_concrete" of relation "hive_members" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 408-routines-ephemeral-tier.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "routines_tier_check" of relation "routines" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 409-seed-starter-recipes.sql
[with-test-pg] pg apply 410-pty-viewer-heartbeats.sql
[with-test-pg] pg apply 411-hive-epoch-keys-capture-insert-or-update.sql
[with-test-pg] pg apply 412-tool-utilization-code-run-adoption.sql
[with-test-pg] pg apply 413-harness-test-runs-scope-columns.sql
[with-test-pg] pg apply 414-harness-plans-owner-author.sql
[with-test-pg] pg apply 416-operator-owner-pins.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_owner_pins_workspace_isolation" for relation "harness_shared.operator_owner_pins" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 417-agent-fleets.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "agent_fleets_workspace_isolation" for relation "harness_shared.agent_fleets" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 418-fleet-assignment-fleet-cols.sql
[with-test-pg] pg apply 419-pipeline-events-kind-content-release-fixer.sql
[with-test-pg] pg apply 420-plan-run-turns-harness-slug.sql
[with-test-pg] pg apply 421-datatype-registry.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "datatype_registry_workspace_isolation" for relation "harness_shared.datatype_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 422-drop-papercup-shared-compat.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'drop cascades to 6 other objects',
  detail: 'drop cascades to view papercup_shared.briefings\n' +
    'drop cascades to view papercup_shared.directive_summaries\n' +
    'drop cascades to view papercup_shared.directives\n' +
    'drop cascades to view papercup_shared.message_comments\n' +
    'drop cascades to view papercup_shared.message_recipients\n' +
    'drop cascades to view papercup_shared.messages',
  where: 'SQL statement "DROP SCHEMA papercup_shared CASCADE"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'dependency.c',
  line: '1171',
  routine: 'reportDependentObjects'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'CONTRACT: dropped papercup_shared compat views + schema',
  where: 'PL/pgSQL function inline_code_block line 16 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 423-d001-restore-work-items-op-hlc.sql
[with-test-pg] pg apply 424-fleet-color-scheme.sql
[with-test-pg] pg apply 425-datatype-review-status.sql
[with-test-pg] pg apply 426-datatype-approved-global-read.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "datatype_registry_approved_global_read" for relation "harness_shared.datatype_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 427-tool-invocations-coord-owner-id.sql
[with-test-pg] pg apply 428-worker-chunk-loop-outcomes-extended-metrics.sql
[with-test-pg] pg apply 429-coord-entity-subscriptions-allow-fleet-kind.sql
[with-test-pg] pg apply 430-fleet-membership-append-only-fact.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "project_fleet_membership_trg" for relation "harness_shared.fleet_membership_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "materialize_presence_fleet_trg" for relation "harness_shared.coord_presence" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "coord_presence_fleet_guard_trg" for relation "harness_shared.coord_presence" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 431-coord-presence-compaction-limit.sql
[with-test-pg] pg apply 432-work-item-completion-integrity.sql
[with-test-pg] pg apply 433-coord-presence-context-tokens.sql
[with-test-pg] pg apply 434-shared-session-presence.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.395 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.399 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 435-comms-trust-list.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.400 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.402 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 436-coord-quarantine.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.403 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.406 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 437-coord-quarantine-rate-reason.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.408 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.408 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 438-bee-claim-specs-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.409 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.410 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 439-bee-claim-specs-hlc-stamp.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.411 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.bee_claim_specs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.411 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 440-hive-placements-last-loss-spawn.sql
[with-test-pg] pg apply 441-hive-integration-requests.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.413 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.416 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 442-gate-verdicts.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.417 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.gate_verdicts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.423 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 443-comms-trust-gate-grant.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.424 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.424 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 444-agent-facts.sql
[with-test-pg] pg apply 445-local-backend-pool.sql
[with-test-pg] pg apply 446-capture-outbox-wire-ts-from-row-fed-ts.sql
[with-test-pg] pg apply 448-usage-events-registry-fallback-backfill.sql
[with-test-pg] pg apply 449-normalize-workspace-id-naming-contract.sql
[with-test-pg] pg apply 450-features-issues-registry-fallback-backfill.sql
[with-test-pg] pg apply 452-work-items-outbox-canonical-slug.sql
[with-test-pg] pg apply 453-operator-activity-workspace-id.sql
[with-test-pg] pg apply 454-work-items-outbox-operator-gap-signal.sql
[with-test-pg] pg apply 455-agent-facts-shareable.sql
[with-test-pg] pg apply 456-adv-sessions-change-notify-drift-repair.sql
[with-test-pg] pg apply 457-tool-invocations-parent-spawn-partial-idx.sql
[with-test-pg] pg apply 458-fed-order-key-transitivity-fix.sql
[with-test-pg] pg apply 459-hlc-node-id-total-order.sql
[with-test-pg] pg apply 460-hlc-recv-drift-clamp.sql
[with-test-pg] pg apply 460-tool-invocations-spawn-tree-function.sql
[with-test-pg] pg apply 461-agent-facts-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.493 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.495 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 462-agent-facts-fed-key.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.496 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.500 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 463-p2p-peer-grants.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.501 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.p2p_peer_grants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.507 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 464-gym-qd-archive-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.508 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.511 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 465-gym-qd-foreign-elites.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.512 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_qd_foreign_elites_workspace_isolation" for relation "harness_shared.gym_qd_foreign_elites" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.517 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 466-hlc-node-id-strong-entropy.sql
[with-test-pg] pg apply 467-p2p-foreign-workspaces.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.524 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.528 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 468-p2p-receipts.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.529 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.p2p_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.536 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 469-shared-presence-author-pubkey.sql
[with-test-pg] pg apply 470-p2p-foreign-workspace-base-sha.sql
[with-test-pg] pg apply 471-scout-routed-ideas-origin.sql
[with-test-pg] pg apply 472-carry-notes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "carry_notes_workspace_isolation" for relation "harness_shared.carry_notes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 473-p2p-resource-allotments.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.546 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.550 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 474-federation-refused-op-counters.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.552 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.554 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 475-spawned-agents-fleet-slug.sql
[with-test-pg] pg apply 476-p2p-fleet-directory.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.557 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "p2p_fleet_directory_workspace_isolation" for relation "harness_shared.p2p_fleet_directory" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.p2p_fleet_directory" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.560 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 477-capture-hive-members-outbox-preserve-fed-ts.sql
[with-test-pg] pg apply 478-elite-outcome-record-federation.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.562 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.563 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 479-shared-session-presence-fleet-slug.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.564 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.565 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 480-event-awaits-pattern-index.sql
[with-test-pg] pg apply 481-gym-qd-outcome-record-capture.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.567 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.568 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 482-code-run-nudge-fires.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "code_run_nudge_fires_workspace_isolation" for relation "harness_shared.code_run_nudge_fires" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 483-p2p-metering-ledger.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.587 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.594 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 484-fleet-launch-guard.sql
[with-test-pg] pg apply 485-work-item-release-cooldown.sql
[with-test-pg] pg apply 486-agent-slot-allotments.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.610 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "resource_allotments_quantity" of relation "resource_allotments" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.611 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 487-agent-seat-consumptions.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.612 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.614 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 488-federated-rls-backstop.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "bee_claim_specs_workspace_isolation" for relation "harness_shared.bee_claim_specs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gate_verdicts_workspace_isolation" for relation "harness_shared.gate_verdicts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "agent_facts_workspace_isolation" for relation "harness_shared.agent_facts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "p2p_peer_grants_workspace_isolation" for relation "harness_shared.p2p_peer_grants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "p2p_receipts_workspace_isolation" for relation "harness_shared.p2p_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 489-perf-regression-ui-slo-columns.sql
[with-test-pg] pg apply 490-p2p-work-offers.sql
[with-test-pg] pg pg: 2026-10-25 15:05:53.620 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "p2p_work_offers_workspace_isolation" for relation "harness_shared.p2p_work_offers" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.p2p_work_offers" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:53.625 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 492-test-runs-saturation-columns.sql
[with-test-pg] pg apply 493-substrate-merge-cursor.sql
[with-test-pg] pg apply 494-contract-carry-notes-drop-legacy-checkpoints.sql
[with-test-pg] pg apply 495-substrate-outbox-drained-log-key.sql
[with-test-pg] pg apply 496-route-invocations-resolved-path.sql
[with-test-pg] pg apply 497-harness-features-shared-fallback-view.sql
[with-test-pg] pg apply 498-agent-facts-replica-identity.sql
[with-test-pg] pg apply 499-issue-family-release-cooldown.sql
[with-test-pg] pg apply 500-agent-modes.sql
[with-test-pg] pg apply 501-session-turns.sql
[with-test-pg] pg apply 502-research-task-to-task-merge.sql
[with-test-pg] pg apply 503-dedupe-engineer-issues-selfheal-trigger.sql
[with-test-pg] pg apply 504-fed-apply-writer-tiebreak.sql
[with-test-pg] pg apply 505-agent-facts-surrogate-pk-replica-identity.sql
[with-test-pg] pg apply 506-pot-rename-slice2-expand.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "coord_presence_pot_hive_sync_trg" for relation "harness_shared.coord_presence" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_item_claims_pot_hive_sync_trg" for relation "harness_shared.work_item_claims" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "cross_hive_asks_pot_hive_sync_trg" for relation "harness_shared.cross_hive_asks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "cross_hive_outbox_pot_hive_sync_trg" for relation "harness_shared.cross_hive_outbox" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "scout_lens_weights_pot_hive_sync_trg" for relation "harness_shared.scout_lens_weights" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hive_integration_requests_pot_hive_sync_trg" for relation "harness_shared.hive_integration_requests" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hive_throughput_ticks_pot_hive_sync_trg" for relation "harness_shared.hive_throughput_ticks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "scout_ticks_pot_hive_sync_trg" for relation "harness_shared.scout_ticks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "improvement_dispatches_pot_hive_sync_trg" for relation "harness_shared.improvement_dispatches" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "memory_feedback_pot_hive_sync_trg" for relation "harness_shared.memory_feedback" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "memory_recall_stats_pot_hive_sync_trg" for relation "harness_shared.memory_recall_stats" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "calibration_predictions_pot_hive_sync_trg" for relation "harness_shared.calibration_predictions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "shared_presence_pot_hive_sync_trg" for relation "harness_shared.shared_presence" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "shared_session_presence_pot_hive_sync_trg" for relation "harness_shared.shared_session_presence" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "datatype_registry_pot_hive_sync_trg" for relation "harness_shared.datatype_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "session_briefs_pot_hive_sync_trg" for relation "harness_shared.session_briefs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "bench_runs_pot_hive_sync_trg" for relation "harness_shared.bench_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "code_recipe_runs_pot_hive_sync_trg" for relation "harness_shared.code_recipe_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 507-emit-change-notify-natural-key.sql
[with-test-pg] pg apply 509-issue-family-progress-and-takenat.sql
[with-test-pg] pg apply 510-engineer-issues-view-dml-target-row.sql
[with-test-pg] pg apply 511-issue-signal-origin-view-default-fix.sql
[with-test-pg] pg apply 512-engineer-issues-signal-origin-default.sql
[with-test-pg] pg apply 513-engineer-issues-preserve-origin-update.sql
[with-test-pg] pg apply 514-engineer-issues-base-origin-trigger.sql
[with-test-pg] pg apply 515-engineer-issues-origin-self-read.sql
[with-test-pg] pg apply 516-engineer-issues-skip-remote-dml.sql
[with-test-pg] pg apply 517-fix-stamp-local-federated-write-mask.sql
[with-test-pg] pg apply 518-p2p-fleet-leader-leases.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "p2p_fleet_leader_leases_workspace_isolation" for relation "harness_shared.p2p_fleet_leader_leases" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.p2p_fleet_leader_leases" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 519-pot-rename-slice2-role-contract.sql
[with-test-pg] pg apply 520-pot-rename-s2-residual-role-backfill.sql
[with-test-pg] pg apply 521-engineer-issues-view-remote-skip-return-null.sql
[with-test-pg] pg apply 522-engineer-issues-operator-scope-empty-slug-cleanup.sql
[with-test-pg] pg apply 523-pot-s3-hive-slug-contract.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'ALTER TABLE / ADD CONSTRAINT USING INDEX will rename index "cross_hive_outbox_pot_pkey_idx" to "cross_hive_outbox_pkey"',
  where: 'SQL statement "ALTER TABLE harness_shared.cross_hive_outbox ADD CONSTRAINT cross_hive_outbox_pkey PRIMARY KEY USING INDEX cross_hive_outbox_pot_pkey_idx"\n' +
    'PL/pgSQL function inline_code_block line 4 at SQL statement',
  file: 'tablecmds.c',
  line: '9753',
  routine: 'ATExecAddIndexConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'ALTER TABLE / ADD CONSTRAINT USING INDEX will rename index "scout_lens_weights_pot_pkey_idx" to "scout_lens_weights_pkey"',
  where: 'SQL statement "ALTER TABLE harness_shared.scout_lens_weights ADD CONSTRAINT scout_lens_weights_pkey PRIMARY KEY USING INDEX scout_lens_weights_pot_pkey_idx"\n' +
    'PL/pgSQL function inline_code_block line 8 at SQL statement',
  file: 'tablecmds.c',
  line: '9753',
  routine: 'ATExecAddIndexConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'ALTER TABLE / ADD CONSTRAINT USING INDEX will rename index "hive_integration_requests_pot_pkey_idx" to "hive_integration_requests_pkey"',
  where: 'SQL statement "ALTER TABLE harness_shared.hive_integration_requests ADD CONSTRAINT hive_integration_requests_pkey PRIMARY KEY USING INDEX hive_integration_requests_pot_pkey_idx"\n' +
    'PL/pgSQL function inline_code_block line 12 at SQL statement',
  file: 'tablecmds.c',
  line: '9753',
  routine: 'ATExecAddIndexConstraint'
}
[with-test-pg] pg apply 524-spawn-sig-failure-classification.sql
[with-test-pg] pg apply 525-fleet-assignment-work-items-notify.sql
[with-test-pg] pg apply 526-add-integration-credentials.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "oic_workspace_isolation" for relation "harness_shared.operator_integration_credentials" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 527-notes-app.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "notes_workspace_isolation" for relation "harness_shared.notes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 528-restore-fed-hlc-insert-stamp.sql
[with-test-pg] pg apply 529-hive-placements-blocked-status.sql
[with-test-pg] pg apply 530-embedding-space-discriminator.sql
[with-test-pg] pg apply 531-rename-hive-coordination-health-rubric-to-pot.sql
[with-test-pg] pg apply 532-coord-presence-intent-declared-at.sql
[with-test-pg] pg apply 533-add-event-awaits-payload-filter.sql
[with-test-pg] pg apply 534-memory-vec-gemma.sql
[with-test-pg] pg apply 535-rekey-stranded-workitem-checkpoints.sql
[with-test-pg] pg apply 536-reply-deadline-partial-index.sql
[with-test-pg] pg apply 537-coord-read-cursors.sql
[with-test-pg] pg apply 539-session-archives.sql
[with-test-pg] pg apply 541-predicate-watches.sql
[with-test-pg] pg apply 542-runtime-vintage-ledger.sql
[with-test-pg] pg apply 543-coord-event-log-msg-id-index.sql
[with-test-pg] pg apply 544-federation-probes.sql
[with-test-pg] pg apply 545-coord-event-log-messages-ts-idx.sql
[with-test-pg] pg apply 546-coord-event-log-ts-repair.sql
[with-test-pg] pg apply 547-memory-vec-harrier.sql
[with-test-pg] pg apply 549-backfill-coord-event-log-body-ts-msgid.sql
[with-test-pg] pg apply 550-event-awaits-announce-scope.sql
[with-test-pg] pg apply 551-work-items-embedding-cols.sql
[with-test-pg] pg apply 552-doc-sections-embeddings.sql
[with-test-pg] pg apply 553-harness-plans-embedding-cols.sql
[with-test-pg] pg apply 554-cup-lexicon-db-rename-phase1.sql
[with-test-pg] pg apply 555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql
[with-test-pg] pg apply 556-coord-event-log-surface-kind-id-idx.sql
[with-test-pg] pg apply 557-cup-lexicon-db-rename-phase3.sql
[with-test-pg] pg apply 558-scout-routed-ideas-created-by.sql
[with-test-pg] pg apply 559-fix-capture-work-items-outbox-pots-rename.sql
[with-test-pg] pg apply 560-fix-capture-engineer-issues-outbox-pots-rename.sql
[with-test-pg] pg apply 561-coord-conditions-partial-index.sql
[with-test-pg] pg apply 562-memory-shareable-federation.sql
[with-test-pg] pg apply 563-memory-federation-capture-triggers.sql
[with-test-pg] pg apply 564-memory-federation-columns.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'index "memory_canonical_fed_identity" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
[with-test-pg] pg apply 565-fix-capture-hive-members-outbox-pot-rename.sql
[with-test-pg] pg apply 566-coord-presence-capability-tags.sql
[with-test-pg] pg apply 567-memory-write-journal.sql
[with-test-pg] pg apply 568-coord-entity-subscriptions-allow-event-kind.sql
[with-test-pg] pg apply 569-event-awaits-policy-allow-announce.sql
[with-test-pg] pg apply 570-memory-canonical-rls.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "memory_canonical_workspace_isolation" for relation "harness_shared.memory_canonical" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 571-scout-ticks-origin.sql
[with-test-pg] pg apply 572-event-await-nodes-threshold-tree.sql
[with-test-pg] pg apply 573-owner-activity-human-turn-presence.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "harness_shared" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
[with-test-pg] pg apply 574-agent-facts-audience-provenance.sql
[with-test-pg] pg apply 575-agent-fleets-control-state.sql
[with-test-pg] pg apply 576-coord-event-log-allhive-broadcast-idx.sql
[with-test-pg] pg apply 578-memory-canonical-temporal-lite.sql
[with-test-pg] pg apply 579-add-session-ingest-state-tool-response-counts.sql
[with-test-pg] pg apply 580-memory-live-recall-canary.sql
[with-test-pg] pg apply 581-memory-session-surfaced-ledger.sql
[with-test-pg] pg apply 582-blender-signal-accumulator.sql
[with-test-pg] pg apply 583-drop-memory-recall-stats-surface-check.sql
[with-test-pg] pg apply 584-beacon-consent-change-notify-natural-key.sql
[with-test-pg] pg apply 585-system-health-v2.sql
[with-test-pg] pg apply 586-agent-launch-idempotency.sql
[with-test-pg] pg apply 587-memory-federation-slug-stamp.sql
[with-test-pg] pg apply 588-issue-family-priority-view-column.sql
[with-test-pg] pg apply 589-releases-registry.sql
[with-test-pg] pg apply 590-recall-canary-consumer-admission-metrics.sql
[with-test-pg] pg apply 591-gate-decisions.sql
[with-test-pg] pg apply 592-knowledge-packs-rename.sql
[with-test-pg] pg apply 593-scout-legacy-grade-cleanup.sql
[with-test-pg] pg apply 594-memory-canonical-trgm-lexical.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42710',
  message: 'extension "pg_trgm" already exists, skipping',
  file: 'extension.c',
  line: '2120',
  routine: 'CreateExtension'
}
[with-test-pg] pg apply 595-agent-control-anchor.sql
[with-test-pg] pg apply 596-agent-control-transitions.sql
[with-test-pg] pg apply 597-owner-directives.sql
[with-test-pg] pg apply 598-saved-prompts-organizer.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "saved_prompts_change_notify" for relation "harness_shared.saved_prompts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 599-event-announcement-generation.sql
[with-test-pg] pg apply 600-fleet-headcount-governor.sql
[with-test-pg] pg apply 601-session-ingest-counts-backfill.sql
[with-test-pg] pg apply 602-work-item-follow-blockers.sql
[with-test-pg] pg apply 603-backup-safe-cadence.sql
[with-test-pg] pg apply 604-operator-context-doors-config.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_context_doors_config_workspace_isolation" for relation "harness_shared.operator_context_doors_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 605-session-turn-journal.sql
[with-test-pg] pg apply 606-saved-prompts-completed.sql
[with-test-pg] pg apply 607-pot-placement-recovery-start.sql
[with-test-pg] pg apply 608-spawned-agents-result-path.sql
[with-test-pg] pg apply 609-session-cursor.sql
[with-test-pg] pg apply 610-push-delivery.sql
[with-test-pg] pg apply 611-session-ports.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "session_ports_workspace_isolation" for relation "harness_shared.session_ports" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 612-collision-hysteresis.sql
[with-test-pg] pg apply 613-topic-hysteresis.sql
[with-test-pg] pg apply 614-adjacency-state.sql
[with-test-pg] pg apply 615-add-context-burn-to-pot-coord-health-rubric.sql
[with-test-pg] pg apply 616-workspace-stamp-consolidated-views.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fill_ws_trg" for relation "harness_shared.agent_chats_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS fill_ws_trg ON harness_shared.agent_chats_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fill_ws_trg" for relation "harness_shared.agent_runs_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS fill_ws_trg ON harness_shared.agent_runs_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fill_ws_trg" for relation "harness_shared.messages_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS fill_ws_trg ON harness_shared.messages_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fill_ws_trg" for relation "harness_shared.executed_actions_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS fill_ws_trg ON harness_shared.executed_actions_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fill_ws_trg" for relation "harness_shared.supervisor_notes_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS fill_ws_trg ON harness_shared.supervisor_notes_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fill_ws_trg" for relation "harness_shared.directive_summaries_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS fill_ws_trg ON harness_shared.directive_summaries_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "fill_ws_trg" for relation "harness_shared.feature_audit_consolidated" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS fill_ws_trg ON harness_shared.feature_audit_consolidated"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 617-routines-grouping.sql
[with-test-pg] pg apply 618-curation-log-title.sql
[with-test-pg] pg apply 619-session-pending-gates.sql
[with-test-pg] pg apply 620-backfill-migration-reservations-ei485.sql
[with-test-pg] pg apply 621-repair-pot-coordination-health-rubric-row.sql
[with-test-pg] pg apply 622-canonicalize-routine-ids.sql
[with-test-pg] pg apply 623-scout-cycle-stage-artifacts.sql
[with-test-pg] pg apply 624-gateway-stall-events.sql
[with-test-pg] pg apply 625-emit-change-notify-feature-id-fallback.sql
[with-test-pg] pg apply 626-pot-scoped-resource-allotments.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "resource_allotments_pot_nonempty" of relation "resource_allotments" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "resource_allotments_audience" of relation "resource_allotments" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "resource_allotments_grantee_xor" of relation "resource_allotments" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "resource_allotments_audience_pot_only" of relation "resource_allotments" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "p2p_work_offers_pot_nonempty" of relation "p2p_work_offers" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "p2p_work_offers_grantee" of relation "p2p_work_offers" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 627-routine-pool-shed-events.sql
[with-test-pg] pg apply 629-derived-read-snapshots.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "derived_read_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "payload" of relation "derived_read_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "computed_at" of relation "derived_read_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "compute_ms" of relation "derived_read_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "producer_version" of relation "derived_read_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error" of relation "derived_read_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "error_at" of relation "derived_read_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "updated_at" of relation "derived_read_snapshots" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
[with-test-pg] pg apply 630-reslug-workspace-bugs-to-papercusp.sql
[with-test-pg] pg apply 631-reslug-operator-workspace-changetask-to-papercusp.sql
[with-test-pg] pg apply 632-event-key-fire-latch.sql
[with-test-pg] pg apply 633-coord-open-escalations-reactivity.sql
[with-test-pg] pg apply 634-autoloop-withhold-tracking.sql
[with-test-pg] pg apply 635-liveness-flap-state.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_liveness_flap_state_workspace_isolation" for relation "harness_shared.operator_liveness_flap_state" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 636-emit-change-notify-remaining-mapped-tables.sql
[with-test-pg] pg apply 637-pot-watchdog-fires-repeat-backoff.sql
[with-test-pg] pg apply 638-unify-workitem-status.sql
[with-test-pg] pg apply 639-knowledge-pack-config.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "knowledge_pack_config_workspace_isolation" for relation "harness_shared.knowledge_pack_config" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 640-unify-workitem-readiness-triggers.sql
[with-test-pg] pg apply 641-engineer-issues-view-dml-payload-scalar-guard.sql
[with-test-pg] pg apply 642-unify-claim-spec-states-todo-to-open.sql
[with-test-pg] pg apply 643-desktop-perf-runs.sql
[with-test-pg] pg apply 644-secrets-guard-path-exemptions.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "secrets_guard_path_exemptions_workspace_isolation" for relation "harness_shared.secrets_guard_path_exemptions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 645-outbox-quarantine-persist.sql
[with-test-pg] pg apply 646-reexpose-terminal-reason-engineer-issues-view.sql
[with-test-pg] pg apply 647-harness-features-consolidated-drift-normalize.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'drop cascades to view harness_shared.harness_features',
  where: 'SQL statement "DROP VIEW IF EXISTS harness_shared.harness_features_consolidated CASCADE"\n' +
    'PL/pgSQL function inline_code_block line 42 at SQL statement',
  file: 'dependency.c',
  line: '1177',
  routine: 'reportDependentObjects'
}
[with-test-pg] pg apply 648-harness-features-dependent-views-column-refresh.sql
[with-test-pg] pg apply 649-pot-membership-backfill.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "_pb649" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "_pb649_drop" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '649: workspace papercusp-workspace has no platform Pot yet — backfill skipped, rows left for the runtime self-heal (mig 652).',
  where: 'PL/pgSQL function inline_code_block line 14 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 650-harness-gym-durable-run-analytics.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_tasks_workspace_isolation" for relation "harness_gym_durable.gym_tasks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_variants_workspace_isolation" for relation "harness_gym_durable.gym_variants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_runs_workspace_isolation" for relation "harness_gym_durable.gym_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_scores_workspace_isolation" for relation "harness_gym_durable.gym_scores" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gym_cycles_workspace_isolation" for relation "harness_gym_durable.gym_cycles" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 651-pot-membership-enforce-trigger.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "pot_membership_check_ins_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "pot_membership_check_upd_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 652-pot-membership-selfheal-reconcile.sql
[with-test-pg] pg apply 653-fed-key-generated-col-stamp-mask.sql
[with-test-pg] pg apply 654-work-item-claim-floors-ssot.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'view "work_items_claimable" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'function harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text,text) does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'function harness_shared.work_item_claim_floors(text,text,text,text,text,text,jsonb,text) does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 655-engineer-issues-claim-race-guard.sql
[with-test-pg] pg apply 656-canonicalize-plan-harness-slug.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "harness_plans_canonicalize_slug" for relation "harness_shared.harness_plans" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "harness_plan_parts_canonicalize_slug" for relation "harness_shared.harness_plan_parts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 657-restore-wi5720-deleted-plan-rows.sql
[with-test-pg] pg apply 658-watchdog-ticks-seen-keys.sql
[with-test-pg] pg apply 659-pot-scope-learning-tables.sql
[with-test-pg] pg apply 660-boot-history-events.sql
[with-test-pg] pg apply 661-add-watchdog-ticks-standing-keys.sql
[with-test-pg] pg apply 663-clamp-gym-999999-budget.sql
[with-test-pg] pg apply 664-widen-fact-body-cap.sql
[with-test-pg] pg apply 665-bash-tool-substitutions.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "bash_tool_substitutions_verdict_chk" of relation "bash_tool_substitutions" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.bash_tool_substitutions\n' +
    '    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_verdict_chk"\n' +
    'PL/pgSQL function inline_code_block line 4 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "bash_tool_substitutions_tier_chk" of relation "bash_tool_substitutions" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.bash_tool_substitutions\n' +
    '    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_tier_chk"\n' +
    'PL/pgSQL function inline_code_block line 12 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "bash_tool_substitutions_tier_requires_equivalence" of relation "bash_tool_substitutions" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.bash_tool_substitutions\n' +
    '    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_tier_requires_equivalence"\n' +
    'PL/pgSQL function inline_code_block line 25 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "bash_tool_substitutions_advisory_required" of relation "bash_tool_substitutions" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.bash_tool_substitutions\n' +
    '    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_advisory_required"\n' +
    'PL/pgSQL function inline_code_block line 37 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "bash_tool_substitutions_verdict_evidence" of relation "bash_tool_substitutions" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.bash_tool_substitutions\n' +
    '    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_verdict_evidence"\n' +
    'PL/pgSQL function inline_code_block line 49 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 666-fleet-assignment-exclude-parked-statuses.sql
[with-test-pg] pg apply 667-substitution-pattern-flags.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "bash_tool_substitutions_pattern_flags_chk" of relation "bash_tool_substitutions" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.bash_tool_substitutions\n' +
    '    DROP CONSTRAINT IF EXISTS bash_tool_substitutions_pattern_flags_chk"\n' +
    'PL/pgSQL function inline_code_block line 28 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 668-fleet-assignment-fleet-slug-workspace-mismatch.sql
[with-test-pg] pg apply 670-add-facts-confidence.sql
[with-test-pg] pg apply 671-add-agent-facts-confidence.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "agent_facts_confidence_check" of relation "agent_facts" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 672-bash-tool-usage-rollup.sql
[with-test-pg] pg apply 673-known-timer-registrations.sql
[with-test-pg] pg apply 674-bash-tool-usage-rollup-intent.sql
[with-test-pg] pg apply 675-normalize-plan-items-decisions.sql
[with-test-pg] pg apply 676-backfill-plan-index-rows.sql
[with-test-pg] pg apply 677-work-item-authority-state.sql
[with-test-pg] pg apply 678-rename-authority-to-completion-authority.sql
[with-test-pg] pg apply 679-engineer-issues-view-dml-carry-authority.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '679: engineer_issues_view_dml now carries authority (INSERT + UPDATE)',
  where: 'PL/pgSQL function inline_code_block line 74 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 680-carry-note-declared-deps.sql
[with-test-pg] pg apply 681-generic-generated-col-stamp-mask.sql
[with-test-pg] pg apply 682-shared-presence-runs-routines.sql
[with-test-pg] pg apply 683-repair-clobbered-completion-credit.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '683: no tool_invocations ledger — nothing to repair.',
  where: 'PL/pgSQL function inline_code_block line 15 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 684-gym-task-corpus-label.sql
[with-test-pg] pg apply 685-substrate-merge-cursor-apply-binding.sql
[with-test-pg] pg apply 686-pots-canonical-home-slug-fk.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "pots_fill_canonical_slug_trg" for relation "harness_shared.pots" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 687-agent-couplings.sql
[with-test-pg] pg apply 688-issue-wire-created-ts-and-terminal-pair.sql
[with-test-pg] pg apply 689-agent-facts-append-versioning.sql
[with-test-pg] pg apply 690-agent-facts-depends-on-kind-claim.sql
[with-test-pg] pg apply 691-coord-event-log-related-msg-id-idx.sql
[with-test-pg] pg apply 692-agent-facts-convention-enforcement.sql
[with-test-pg] pg apply 693-agent-facts-federation-stamp-regime.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_local_federated_write_trg" for relation "harness_shared.agent_facts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 694-tool-invocations-agent-state-stamp.sql
[with-test-pg] pg apply 695-boot-history-events-origin-column.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "boot_history_events_origin_check" of relation "boot_history_events" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 696-task-ledger.sql
[with-test-pg] pg apply 697-agent-plane-measurements.sql
[with-test-pg] pg apply 698-work-items-closed-ts.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_work_item_closed_ts_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '698: engineer_issues now exposes closed_ts',
  where: 'PL/pgSQL function inline_code_block line 53 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '698: harness_features_consolidated now exposes closed_ts',
  where: 'PL/pgSQL function inline_code_block line 53 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '698: closed_ts installed (column + set-once trigger + both family views)',
  where: 'PL/pgSQL function inline_code_block line 26 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 699-restore-hlc-recv-advance.sql
[with-test-pg] pg apply 700-task-ledger-bash-job-id-idx.sql
[with-test-pg] pg apply 701-test-runs-scratch-config-flag.sql
[with-test-pg] pg apply 702-session-turn-parts.sql
[with-test-pg] pg apply 703-memory-recall-stats-per-pool.sql
[with-test-pg] pg apply 704-rescope-papercup-memories-to-papercusp.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '[704] re-scoped papercup→papercusp: payload_user_id=0, payload_harness_slug=0, payload_workspace_id=0',
  where: 'PL/pgSQL function inline_code_block line 58 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 705-memory-recall-stats-score-scale.sql
[with-test-pg] pg apply 706-memory-recall-stats-query-shape.sql
[with-test-pg] pg apply 707-adv-sessions-first-seen-at.sql
[with-test-pg] pg apply 708-federate-work-item-authority.sql
[with-test-pg] pg apply 709-test-runs-worktree-dirty.sql
[with-test-pg] pg apply 710-event-awaits-effective-deadline-view.sql
[with-test-pg] pg apply 711-engineer-issues-view-dml-return-stored-row.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '711: engineer_issues_view_dml now returns the stored row on INSERT and UPDATE',
  where: 'PL/pgSQL function inline_code_block line 117 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 712-corpus-session-surfaced.sql
[with-test-pg] pg apply 713-fleet-invariants.sql
[with-test-pg] pg apply 714-plan-input-schema.sql
[with-test-pg] pg apply 715-account-pool-change-notify.sql
[with-test-pg] pg apply 716-session-respawn-expected-marker.sql
[with-test-pg] pg apply 717-scout-plan-sweep-partial-index.sql
[with-test-pg] pg apply 718-pot-frontier-survey-partial-indexes.sql
[with-test-pg] pg apply 719-fix-work-item-is-blocked-workspace-scope.sql
[with-test-pg] pg apply 720-bash-substitution-fire-telemetry.sql
[with-test-pg] pg apply 721-work-items-lane-generated-column.sql
[with-test-pg] pg apply 722-agent-facts-evicted-at.sql
[with-test-pg] pg apply 723-p2p-receipts-honored-kind.sql
[with-test-pg] pg apply 724-shared-presence-active-routines.sql
[with-test-pg] pg apply 725-payload-object-shape-guard-and-plan-item-stamp-index.sql
[with-test-pg] pg apply 726-preserve-terminal-attribution-on-federated-write.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "preserve_work_item_terminal_attribution_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 727-widen-prose-embedding-cols-to-gemma-native-768.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: 12 column(s) to widen',
  where: 'PL/pgSQL function inline_code_block line 110 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: 3 dependent view(s) to drop and recreate',
  where: 'PL/pgSQL function inline_code_block line 212 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: DROP VIEW harness_shared.harness_features',
  where: 'PL/pgSQL function inline_code_block line 217 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: DROP VIEW harness_shared.work_items_claimable',
  where: 'PL/pgSQL function inline_code_block line 217 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: DROP VIEW harness_shared.harness_features_consolidated',
  where: 'PL/pgSQL function inline_code_block line 217 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping session_turns_embedding_idx to widen session_turns.text_embedding',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.session_turns.text_embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping operator_turns_text_embedding_hnsw to widen operator_turns.text_embedding',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.operator_turns.text_embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping work_items_embedding_hnsw_idx to widen work_items.embedding',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.work_items.embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping doc_sections_embedding_hnsw_idx to widen doc_sections.embedding',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.doc_sections.embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping harness_plans_embedding_hnsw_idx to widen harness_plans.embedding',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.harness_plans.embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping harness_escalations_body_embedding_hnsw to widen harness_escalations.body_embedding',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.harness_escalations.body_embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping harness_brainstorm_content_embedding_hnsw to widen harness_brainstorm.content_embedding',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.harness_brainstorm.content_embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping harness_decisions_body_embedding_hnsw to widen harness_decisions.body_embedding',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.harness_decisions.body_embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.code_recipes.embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.datatype_registry.embedding to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping memory_vec_gemma_hnsw_idx to widen memory_vec_gemma.vector',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: harness_shared.memory_vec_gemma.vector is NOT NULL — deleting rows so the widening can proceed (refill re-INSERTs them; see comment above)',
  where: 'PL/pgSQL function inline_code_block line 321 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.memory_vec_gemma.vector to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: dropping memory_vec_openai_hnsw_idx to widen memory_vec_openai.vector',
  where: 'PL/pgSQL function inline_code_block line 266 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: widening harness_shared.memory_vec_openai.vector to vector(768)',
  where: 'PL/pgSQL function inline_code_block line 334 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX session_turns_embedding_idx ON harness_shared.session_turns USING h',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX operator_turns_text_embedding_hnsw ON harness_shared.operator_turns',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX work_items_embedding_hnsw_idx ON harness_shared.work_items USING hn',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX doc_sections_embedding_hnsw_idx ON harness_shared.doc_sections USIN',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX harness_plans_embedding_hnsw_idx ON harness_shared.harness_plans US',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX harness_escalations_body_embedding_hnsw ON harness_shared.harness_e',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX harness_brainstorm_content_embedding_hnsw ON harness_shared.harness',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX harness_decisions_body_embedding_hnsw ON harness_shared.harness_dec',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX memory_vec_gemma_hnsw_idx ON harness_shared.memory_vec_gemma USING ',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: rebuilding index: CREATE INDEX memory_vec_openai_hnsw_idx ON harness_shared.memory_vec_openai USIN',
  where: 'PL/pgSQL function inline_code_block line 356 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '727: done — 12 column(s) widened, 46 view statement(s) replayed',
  where: 'PL/pgSQL function inline_code_block line 365 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 728-issue-view-dml-own-node-origin-leg.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '728: engineer_issues_view_dml() now admits own-node round-tripped rows',
  where: 'PL/pgSQL function inline_code_block line 72 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 729-wi7057-restore-clobbered-terminal-attribution.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '729: no damaged rows found (0 already marked by a previous run) — nothing to do.',
  where: 'PL/pgSQL function inline_code_block line 48 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 730-agent-facts-undecidable-kind.sql
[with-test-pg] pg apply 731-reapply-issue-capture-closed-ts.sql
[with-test-pg] pg apply 732-coord-event-log-supersession.sql
[with-test-pg] pg apply 733-grant-pg-read-all-stats-harness-admin.sql
[with-test-pg] pg apply 734-repoint-qualified-refs-on-rehome.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "repoint_qualified_refs_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '734: re-pointed 0 stale qualified ref group(s) left by earlier re-homes',
  where: 'PL/pgSQL function inline_code_block line 46 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 735-adv-sessions-ended-by.sql
[with-test-pg] pg apply 736-coord-event-log-hindsight-notify-idx.sql
[with-test-pg] pg apply 737-backfill-gate-needshuman-mirror.sql
[with-test-pg] pg apply 738-adv-sessions-launch-spec.sql
[with-test-pg] pg apply 739-substrate-booted-handles-status.sql
[with-test-pg] pg apply 740-agent-chat-locks-pg-backed.sql
[with-test-pg] pg apply 741-work-items-condition-key-singleton.sql
[with-test-pg] pg apply 742-backfill-bridge-mint-marker.sql
[with-test-pg] pg apply 743-backfill-agent-chat-counts-wi4297.sql
[with-test-pg] pg apply 744-plan-lane-floor-op-status.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'function harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text,text) does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'function harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text) does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 745-routine-loop-transitions.sql
[with-test-pg] pg apply 746-embed-coverage-samples.sql
[with-test-pg] pg apply 747-backfill-memory-taxonomy-scope-kind.sql
[with-test-pg] pg apply 748-corpus-term-df.sql
[with-test-pg] pg apply 749-session-turn-chunks.sql
[with-test-pg] pg apply 750-drop-dead-hfc-partial-indexes.sql
[with-test-pg] pg apply 751-drop-redundant-tool-usage-rollup-verb-idx.sql
[with-test-pg] pg apply 752-drop-redundant-memory-recall-stats-pools-idx.sql
[with-test-pg] pg apply 753-session-turns-chunkable-idx.sql
[with-test-pg] pg apply 754-drop-three-dead-partial-indexes.sql
[with-test-pg] pg apply 755-drop-memory-canonical-current-idx.sql
[with-test-pg] pg apply 756-pgss-grant-reset-harness-admin.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '[756] pg_stat_statements not installed; nothing to grant',
  where: 'PL/pgSQL function inline_code_block line 4 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 757-memory-canonical-row-kind-discriminator.sql
[with-test-pg] pg apply 758-memory-recall-stats-leg-provenance.sql
[with-test-pg] pg apply 759-plan-blockedby-claim-floor.sql
[with-test-pg] pg apply 761-attention-notifications-audit.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "workspace_id" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "harness_slug" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "kind" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "title" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "importance" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "data" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "created_at" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mobile_attempted" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mobile_succeeded" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mobile_error" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "mobile_completed_at" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "desktop_attempted" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "desktop_succeeded" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "desktop_error" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "desktop_completed_at" of relation "attention_notifications" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
[with-test-pg] pg apply 762-attention-notifications-rls.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "attention_notifications_workspace_isolation" for relation "harness_shared.attention_notifications" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 763-agent-modes-change-notify.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.agent_modes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 764-work-items-completion-evidence-column-comments.sql
[with-test-pg] pg apply 765-goal-projects-link.sql
[with-test-pg] pg apply 766-goal-projects-rls.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "goal_projects_workspace_isolation" for relation "harness_shared.goal_projects" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 767-agent-modes-subject.sql
[with-test-pg] pg apply 768-coord-presence-tty-column.sql
[with-test-pg] pg apply 769-goal-project-kill-criterion.sql
[with-test-pg] pg apply 770-memory-recall-stats-client.sql
[with-test-pg] pg apply 771-memory-recall-cosine-and-query-text.sql
[with-test-pg] pg apply 772-context-injection-coverage.sql
[with-test-pg] pg apply 773-backfill-observation-lane-from-topic-tag.sql
[with-test-pg] pg apply 774-task-ledger-ended-unobserved-state.sql
[with-test-pg] pg apply 775-drop-dead-agent-usage-plan-id.sql
[with-test-pg] pg apply 776-expose-work-item-embedding-on-engineer-issues-view.sql
[with-test-pg] pg apply 777-work-items-embedding-recipe-discriminator.sql
[with-test-pg] pg apply 778-work-item-field-semantics-comments.sql
[with-test-pg] pg apply 779-fleet-brief-snapshots.sql
[with-test-pg] pg apply 780-loop-transition-revived-event-comment.sql
[with-test-pg] pg apply 781-doc-content-canonical.sql
[with-test-pg] pg apply 782-goal-projects-rename-to-goal-pots.sql
[with-test-pg] pg apply 783-harness-docs-projected-clients.sql
[with-test-pg] pg apply 784-edit-attribution-acquired-via.sql
[with-test-pg] pg apply 785-inherit-goal-context-at-launch.sql
[with-test-pg] pg apply 786-goal-launch-settings.sql
[with-test-pg] pg apply 787-harness-docs-content-claim-honesty.sql
[with-test-pg] pg apply 788-drop-goal-projects-compat-view.sql
[with-test-pg] pg apply 789-harness-docs-pg-canonical-content.sql
[with-test-pg] pg apply 790-expose-goal-id-on-engineer-issues-view.sql
[with-test-pg] pg apply 791-plans-goal-provenance.sql
[with-test-pg] pg apply 792-tool-invocations-quota-idx-count-refused.sql
[with-test-pg] pg apply 793-backfill-observation-lane-residue.sql
[with-test-pg] pg apply 794-session-turns-provenance-at-ingest.sql
[with-test-pg] pg apply 795-agent-facts-volatile-measurements.sql
[with-test-pg] pg apply 796-conversation-supersession.sql
[with-test-pg] pg apply 799-guard-797-message-self-diagnosis.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: "799: migration 797's terminal guard is not installed on this database (797 is parked) — nothing to diagnose; no-op",
  where: 'PL/pgSQL function inline_code_block line 37 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 800-adv-sessions-ended-by-signal.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "adv_sessions_ended_signal_check" of relation "adv_sessions" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 801-agent-facts-retraction-reason.sql
[with-test-pg] pg apply 802-agent-owner-predicate.sql
[with-test-pg] pg apply 803-work-item-parent-update.sql
[with-test-pg] pg apply 804-fix-terminal-close-staging-remedy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: "804: migration 797's terminal guard is not installed on this database (797 is parked) — no staging remedy is needed; no-op",
  where: 'PL/pgSQL function inline_code_block line 31 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 805-flush-gate-refusal-marker.sql
[with-test-pg] pg apply 806-work-item-worked-history.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_items_worked_by_history_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "record_work_item_worked_by_history_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 807-backfill-migration-reservations-ei20224121418388370.sql
[with-test-pg] pg apply 808-account-pool-membership-audit.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "operator_account_pool_membership_audit" for relation "harness_shared.operator_account_pool" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 809-tool-invocations-call-origin.sql
[with-test-pg] pg apply 810-claim-spec-revision-history.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "cup_claim_spec_revisions_workspace_isolation" for relation "harness_shared.cup_claim_spec_revisions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 811-sql-read-census.sql
[with-test-pg] pg apply 812-supervision-pause-state.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_supervision_pause_state_workspace_isolation" for relation "harness_shared.operator_supervision_pause_state" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 813-contention-free-hlc-sequence.sql
[with-test-pg] pg apply 814-harness-docs-retired-at.sql
[with-test-pg] pg apply 815-expose-claim-spec-fields-on-engineer-issues-view.sql
[with-test-pg] pg apply 816-backfill-migration-reservation-815-wi38348.sql
[with-test-pg] pg apply 817-backfill-migration-reservation-815.sql
[with-test-pg] pg apply 818-backfill-migration-reservation-815.sql
[with-test-pg] pg apply 819-backfill-migration-reservation-815.sql
[with-test-pg] pg apply 820-backfill-launch-provenance-fallback.sql
[with-test-pg] pg apply 821-agent-activity-session-id-index.sql
[with-test-pg] pg apply 822-sql-read-census-deliberate-no-pair.sql
[with-test-pg] pg apply 823-retire-p2p-work-intake.sql
[with-test-pg] pg apply 824-publisher-signed-local-write-guard.sql
[with-test-pg] pg apply 825-verified-wait-producer-health.sql
[with-test-pg] pg apply 826-repair-work-item-physical-twins.sql
[with-test-pg] pg apply 827-backfill-migration-reservation-825.sql
[with-test-pg] pg apply 829-harness-qualify-engineer-issue-op-identity.sql
[with-test-pg] pg apply 830-fleet-launch-transaction-state.sql
[with-test-pg] pg apply 831-issue-occurrence-ledger.sql
[with-test-pg] pg apply 832-plan-audits.sql
[with-test-pg] pg apply 833-fleet-stall-anchor-newest-claim-progress.sql
[with-test-pg] pg apply 834-consult-threads.sql
[with-test-pg] pg apply 835-knowledge-pack-candidate-review-errors.sql
[with-test-pg] pg apply 836-drop-invalid-ccnew-indexes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'migration 836: dropped 0 invalid _ccnew index(es), reclaiming 0 bytes',
  where: 'PL/pgSQL function inline_code_block line 43 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 837-consult-query-embedding.sql
[with-test-pg] pg apply 838-graded-by-auto-grader.sql
[with-test-pg] pg apply 839-interest-watches.sql
[with-test-pg] pg apply 840-hlc-advisory-lock-cancel-safe.sql
[with-test-pg] pg apply 841-search-judge-grade-cache.sql
[with-test-pg] pg apply 842-work-items-observation-expr-indexes.sql
[with-test-pg] pg apply 843-local-backend-lifecycle.sql
[with-test-pg] pg apply 844-consult-cascade-cursor.sql
[with-test-pg] pg apply 845-local-backends-last-busy-at.sql
[with-test-pg] pg apply 846-coverage-census-tables.sql
[with-test-pg] pg apply 847-widen-consult-interest-vecs-to-768.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '847: consult_state.query_embedding widened 384 -> 768',
  where: 'PL/pgSQL function inline_code_block line 23 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'index "interest_watches_embedding_idx" does not exist, skipping',
  where: 'SQL statement "DROP INDEX IF EXISTS harness_shared.interest_watches_embedding_idx"\n' +
    'PL/pgSQL function inline_code_block line 41 at EXECUTE',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '847: interest_watches.embedding widened 384 -> 768',
  where: 'PL/pgSQL function inline_code_block line 44 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 849-popup-orient-disclosures.sql
[with-test-pg] pg apply 850-test-runs-future-timestamp-clamp.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "test_runs_clamp_future_timestamps" for relation "harness_shared.test_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 851-first-class-plan-spec-clauses.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "plan_spec_clause_revisions_immutable" for relation "harness_shared.plan_spec_clause_revisions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_spec_clauses_workspace_isolation" for relation "harness_shared.plan_spec_clauses" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_spec_clause_revisions_workspace_isolation" for relation "harness_shared.plan_spec_clause_revisions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 852-plan-spec-clause-integrity.sql
[with-test-pg] pg apply 853-plan-item-terminal-claim-floor.sql
[with-test-pg] pg apply 854-substrate-merge-cursor-peer-lifecycle.sql
[with-test-pg] pg apply 855-work-item-spec-evidence-bindings.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "spec_evidence_bindings_validate_refs" for relation "harness_shared.spec_evidence_bindings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_item_spec_revision_edges_immutable" for relation "harness_shared.work_item_spec_revision_edges" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "spec_evidence_bindings_immutable" for relation "harness_shared.spec_evidence_bindings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "work_item_spec_revision_edges_workspace_isolation" for relation "harness_shared.work_item_spec_revision_edges" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "spec_evidence_bindings_workspace_isolation" for relation "harness_shared.spec_evidence_bindings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 856-backfill-answered-expired-consult-outcomes.sql
[with-test-pg] pg apply 857-agent-activity-workspace-id-index.sql
[with-test-pg] pg apply 858-scout-routing-decisions-artifact.sql
[with-test-pg] pg apply 859-repair-work-item-legacy-replay-twins.sql
[with-test-pg] pg apply 860-agent-review-claim-floor.sql
[with-test-pg] pg apply 861-plan-forced-past-index.sql
[with-test-pg] pg apply 862-dream-runs-ledger.sql
[with-test-pg] pg apply 863-owner-action-claim-floor.sql
[with-test-pg] pg apply 864-migrate-legacy-human-parks-to-agent-review.sql
[with-test-pg] pg apply 865-work-items-watchdog-key-identity-guard.sql
[with-test-pg] pg apply 866-clear-issue-expiry.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '866: cleared expires_at on 0 issue-family row(s); feature-family leases preserved',
  where: 'PL/pgSQL function inline_code_block line 25 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 867-repair-post-864-legacy-human-park-recurrence.sql
[with-test-pg] pg apply 868-preserve-legacy-human-park-status.sql
[with-test-pg] pg apply 869-predicate-watch-changed-op.sql
[with-test-pg] pg apply 870-retire-post-868-legacy-human-park-recurrence.sql
[with-test-pg] pg apply 871-lifecycle-bound-watches.sql
[with-test-pg] pg apply 872-session-brief-ambient-exclusion-fence.sql
[with-test-pg] pg apply 873-fleet-headcount-profile-64.sql
[with-test-pg] pg apply 874-personal-vault.sql
[with-test-pg] pg apply 875-engineer-issues-view-payload-preserve.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '875: engineer_issues_view_dml now preserves existing payload keys on partial updates',
  where: 'PL/pgSQL function inline_code_block line 54 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 876-external-trigger-core.sql
[with-test-pg] pg apply 877-canonical-external-datatypes.sql
[with-test-pg] pg apply 878-external-trigger-dispatch-routine.sql
[with-test-pg] pg apply 879-trigger-source-owner-user.sql
[with-test-pg] pg apply 880-session-turn-parts-backfill.sql
[with-test-pg] pg apply 881-goal-usage-attribution.sql
[with-test-pg] pg apply 882-oauth-flow-private-context.sql
[with-test-pg] pg apply 883-user-session-workspace-capability-claims.sql
[with-test-pg] pg apply 884-adv-sessions-workspace-first-seen-keyset.sql
[with-test-pg] pg apply 885-design-features-created-keyset.sql
[with-test-pg] pg apply 886-backfill-consult-conversation-lifecycle.sql
[with-test-pg] pg apply 887-workspace-host-observability.sql
[with-test-pg] pg apply 888-google-calendar-poll-routine.sql
[with-test-pg] pg apply 889-owned-trigger-source-uniqueness.sql
[with-test-pg] pg apply 890-coord-presence-compaction-explicit.sql
[with-test-pg] pg apply 891-google-gmail-poll-routine.sql
[with-test-pg] pg apply 892-triage-ledger-snapshot.sql
[with-test-pg] pg apply 893-triage-ledger-strict-cluster.sql
[with-test-pg] pg apply 894-triage-corpus-views.sql
[with-test-pg] pg apply 895-code-recipe-execution-traces.sql
[with-test-pg] pg apply 896-work-items-state-changed-at.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_work_item_state_changed_at_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '896: state_changed_at installed on work_items and engineer_issues',
  where: 'PL/pgSQL function inline_code_block line 17 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 897-code-recipe-contract.sql
[with-test-pg] pg apply 898-external-trigger-binding-detach.sql
[with-test-pg] pg apply 899-facebook-personal-vault-poll-routine.sql
[with-test-pg] pg apply 900-desktop-sessions-registry.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '900: desktop_sessions registry installed',
  where: 'PL/pgSQL function inline_code_block line 21 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 901-work-item-papercup-conversations.sql
[with-test-pg] pg apply 902-hosted-session-webhook-receipts.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "papercusp_auth" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
[with-test-pg] pg apply 903-customer-organization-boundary.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "papercusp_auth" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '903: hosted customer organization boundary installed',
  where: 'PL/pgSQL function inline_code_block line 35 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 904-hosted-identity-links.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "papercusp_auth" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '904: hosted user and external identity link schema installed',
  where: 'PL/pgSQL function inline_code_block line 27 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 905-desktop-session-lifecycle.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '905: desktop_sessions lifecycle columns installed',
  where: 'PL/pgSQL function inline_code_block line 35 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 906-customer-workspace-directory.sql
[with-test-pg] pg apply 907-hosted-governance.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "papercusp_auth" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "legal_acceptances_append_only_trg" for relation "papercusp_auth.legal_acceptances" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "organization_audit_events_append_only_trg" for relation "papercusp_auth.organization_audit_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "support_access_grants_revoke_only_trg" for relation "papercusp_auth.support_access_grants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '907: hosted customer governance records installed',
  where: 'PL/pgSQL function inline_code_block line 31 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 908-plan-output-schema.sql
[with-test-pg] pg apply 909-routines-next-fire-ms-precision.sql
[with-test-pg] pg apply 911-work-item-dependency-unlock-score.sql
[with-test-pg] pg apply 912-attention-bulk-resolve-runs.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "attention_bulk_runs_workspace_isolation" for relation "harness_shared.attention_bulk_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "attention_bulk_run_items_workspace_isolation" for relation "harness_shared.attention_bulk_run_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 913-goal-standing-flag.sql
[with-test-pg] pg apply 914-goal-budget-window.sql
[with-test-pg] pg apply 916-bulk-run-single-flight.sql
[with-test-pg] pg apply 917-federation-probes-captured-only-contract.sql
[with-test-pg] pg apply 918-goal-budget-window-validate.sql
[with-test-pg] pg apply 919-adv-sessions-shutdown-accepted.sql
[with-test-pg] pg apply 921-trigger-bindings-goal-target.sql
[with-test-pg] pg apply 922-datatype-display-spec.sql
[with-test-pg] pg apply 923-typed-goal-plan-properties.sql
[with-test-pg] pg pg: 2026-10-25 15:05:55.953 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
[with-test-pg] pg pg: 2026-10-25 15:05:55.958 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 925-fleet-leader-watch-suppression.sql
[with-test-pg] pg apply 927-goal-io-schemas.sql
[with-test-pg] pg apply 928-external-prerequisite-attestations.sql
[with-test-pg] pg apply 929-spec-clause-falsifier.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "plan_spec_clause_revisions_falsifier_shape" of relation "plan_spec_clause_revisions" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 930-spec-clause-falsifier-null-safe.sql
[with-test-pg] pg apply 933-routines-active-changed-at.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "routines_active_changed_at_trg" for relation "harness_shared.routines" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 934-agent-loop-approvals.sql
[with-test-pg] pg apply 935-canonical-work-item-blocking-edges.sql
[with-test-pg] pg apply 936-agent-loop-sessions.sql
[with-test-pg] pg apply 937-bulk-run-kind-plan-cleanup.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_cleanup_run_findings_workspace_isolation" for relation "harness_shared.plan_cleanup_run_findings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 938-plan-activation-audits.sql
[with-test-pg] pg apply 939-owner-loop-role-uniqueness.sql
[with-test-pg] pg apply 940-agent-facts-recheck-contract.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "agent_facts_recheck_contract_check" of relation "agent_facts" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 941-event-awaits-exact-key-newest-only.sql
[with-test-pg] pg apply 942-learning-routine-group-completeness-sql.sql
[with-test-pg] pg apply 943-bulk-run-launch-snapshot.sql
[with-test-pg] pg apply 944-work-queue-admission-dedup.sql
[with-test-pg] pg apply 945-bulk-run-heartbeat.sql
[with-test-pg] pg apply 946-expose-admission-on-engineer-issues-view.sql
[with-test-pg] pg apply 947-scout-routed-idea-model-provenance.sql
[with-test-pg] pg apply 948-design-compare-artifact-kinds.sql
[with-test-pg] pg apply 949-coord-presence-state-only-contract.sql
[with-test-pg] pg apply 950-retire-post-870-legacy-needs-human-recurrence-wave2.sql
[with-test-pg] pg apply 952-work-queue-admission-runtime.sql
[with-test-pg] pg apply 953-event-announcement-logical-gate.sql
[with-test-pg] pg apply 954-agent-couplings-relation-column.sql
[with-test-pg] pg apply 955-workspace-host-initialization-replay.sql
[with-test-pg] pg apply 956-workspace-host-desired-spec.sql
[with-test-pg] pg apply 958-required-wake-attempt-ledger.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "event_wake_attempts_workspace_isolation" for relation "harness_shared.event_wake_attempts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 959-owned-trigger-source-account-identity.sql
[with-test-pg] pg apply 960-restore-owned-trigger-legacy-arbiter.sql
[with-test-pg] pg apply 961-coord-conversations-producer-attribution.sql
[with-test-pg] pg apply 963-backfill-blank-owner-answered-consult-outcomes.sql
[with-test-pg] pg apply 964-fleet-type-single-paired.sql
[with-test-pg] pg apply 965-federate-engineer-issue-admission-plan-provenance.sql
[with-test-pg] pg apply 966-expose-admission-on-harness-features-consolidated-view.sql
[with-test-pg] pg apply 967-operator-session-confinements.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_session_confinements_workspace_isolation" for relation "harness_shared.operator_session_confinements" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 968-self-review-turn-parts-owner-ts-idx.sql
[with-test-pg] pg apply 969-drop-orphaned-capture-engineer-issues-outbox.sql
[with-test-pg] pg apply 971-external-trigger-recoverable-retry.sql
[with-test-pg] pg apply 972-completion-authority-content-identity-floor.sql
[with-test-pg] pg pg: 2026-10-25 15:05:56.157 EDT [3319074] WARNING:  there is already a transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25001',
  message: 'there is already a transaction in progress',
  file: 'xact.c',
  line: '3956',
  routine: 'BeginTransactionBlock'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "completion_authority_floor_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg pg: 2026-10-25 15:05:56.158 EDT [3319074] WARNING:  there is no transaction in progress

{
  severity_local: 'WARNING',
  severity: 'WARNING',
  code: '25P01',
  message: 'there is no transaction in progress',
  file: 'xact.c',
  line: '4075',
  routine: 'EndTransactionBlock'
}
[with-test-pg] pg apply 973-fix-malformed-workspace-partitions.sql
[with-test-pg] pg apply 974-adv-sessions-resume-reservation.sql
[with-test-pg] pg apply 975-remove-owned-trigger-legacy-arbiter.sql
[with-test-pg] pg apply 976-stagger-green-checkpoint-crons.sql
[with-test-pg] pg apply 977-reschedule-staggered-green-checkpoints.sql
[with-test-pg] pg apply 978-hosted-customer-rls.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_users_app_select" for relation "papercusp_auth.hosted_users" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_users_service_select" for relation "papercusp_auth.hosted_users" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_users_service_insert" for relation "papercusp_auth.hosted_users" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_users_service_update" for relation "papercusp_auth.hosted_users" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "external_identities_app_select" for relation "papercusp_auth.external_identities" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "external_identities_service_select" for relation "papercusp_auth.external_identities" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "external_identities_service_insert" for relation "papercusp_auth.external_identities" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "external_identities_service_update" for relation "papercusp_auth.external_identities" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organizations_app_select" for relation "papercusp_auth.organizations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organizations_service_select" for relation "papercusp_auth.organizations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organizations_service_insert" for relation "papercusp_auth.organizations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organizations_service_update" for relation "papercusp_auth.organizations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_invitation_refs_app_scope" for relation "papercusp_auth.organization_invitation_refs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_invitation_refs_service_select" for relation "papercusp_auth.organization_invitation_refs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_invitation_refs_service_insert" for relation "papercusp_auth.organization_invitation_refs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_invitation_refs_service_update" for relation "papercusp_auth.organization_invitation_refs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_memberships_app_scope" for relation "papercusp_auth.organization_memberships" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_memberships_service_select" for relation "papercusp_auth.organization_memberships" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_memberships_service_reduce" for relation "papercusp_auth.organization_memberships" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "customer_workspaces_app_scope" for relation "harness_shared.customer_workspaces" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_grants_app_scope" for relation "harness_shared.workspace_grants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "organization_memberships_hosted_service_reduce_trg" for relation "papercusp_auth.organization_memberships" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '907: hosted customer FORCE RLS boundary installed',
  where: 'PL/pgSQL function inline_code_block line 60 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 979-workspace-host-tenant-rls.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_connections_local_workspace_isolation" for relation "harness_shared.workspace_host_connections" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_connections_local_workspace_isolation ON harness_shared.workspace_host_connections"\n' +
    'PL/pgSQL function inline_code_block line 27 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_connections_local_read_isolation" for relation "harness_shared.workspace_host_connections" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_connections_local_read_isolation ON harness_shared.workspace_host_connections"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_connections_hosted_tenant_isolation" for relation "harness_shared.workspace_host_connections" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_connections_hosted_tenant_isolation ON harness_shared.workspace_host_connections"\n' +
    'PL/pgSQL function inline_code_block line 45 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_hosts_local_workspace_isolation" for relation "harness_shared.workspace_hosts" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_hosts_local_workspace_isolation ON harness_shared.workspace_hosts"\n' +
    'PL/pgSQL function inline_code_block line 27 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_hosts_local_read_isolation" for relation "harness_shared.workspace_hosts" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_hosts_local_read_isolation ON harness_shared.workspace_hosts"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_hosts_hosted_tenant_isolation" for relation "harness_shared.workspace_hosts" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_hosts_hosted_tenant_isolation ON harness_shared.workspace_hosts"\n' +
    'PL/pgSQL function inline_code_block line 45 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_operations_local_workspace_isolation" for relation "harness_shared.workspace_host_operations" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_operations_local_workspace_isolation ON harness_shared.workspace_host_operations"\n' +
    'PL/pgSQL function inline_code_block line 27 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_operations_local_read_isolation" for relation "harness_shared.workspace_host_operations" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_operations_local_read_isolation ON harness_shared.workspace_host_operations"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_operations_hosted_tenant_isolation" for relation "harness_shared.workspace_host_operations" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_operations_hosted_tenant_isolation ON harness_shared.workspace_host_operations"\n' +
    'PL/pgSQL function inline_code_block line 45 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_resources_local_workspace_isolation" for relation "harness_shared.workspace_host_resources" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_resources_local_workspace_isolation ON harness_shared.workspace_host_resources"\n' +
    'PL/pgSQL function inline_code_block line 27 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_resources_local_read_isolation" for relation "harness_shared.workspace_host_resources" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_resources_local_read_isolation ON harness_shared.workspace_host_resources"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_resources_hosted_tenant_isolation" for relation "harness_shared.workspace_host_resources" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_resources_hosted_tenant_isolation ON harness_shared.workspace_host_resources"\n' +
    'PL/pgSQL function inline_code_block line 45 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_events_local_workspace_isolation" for relation "harness_shared.workspace_host_events" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_events_local_workspace_isolation ON harness_shared.workspace_host_events"\n' +
    'PL/pgSQL function inline_code_block line 27 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_events_local_read_isolation" for relation "harness_shared.workspace_host_events" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_events_local_read_isolation ON harness_shared.workspace_host_events"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_events_hosted_tenant_isolation" for relation "harness_shared.workspace_host_events" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_events_hosted_tenant_isolation ON harness_shared.workspace_host_events"\n' +
    'PL/pgSQL function inline_code_block line 45 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_logs_local_workspace_isolation" for relation "harness_shared.workspace_host_logs" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_logs_local_workspace_isolation ON harness_shared.workspace_host_logs"\n' +
    'PL/pgSQL function inline_code_block line 27 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_logs_local_read_isolation" for relation "harness_shared.workspace_host_logs" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_logs_local_read_isolation ON harness_shared.workspace_host_logs"\n' +
    'PL/pgSQL function inline_code_block line 36 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workspace_host_logs_hosted_tenant_isolation" for relation "harness_shared.workspace_host_logs" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS workspace_host_logs_hosted_tenant_isolation ON harness_shared.workspace_host_logs"\n' +
    'PL/pgSQL function inline_code_block line 45 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '908: organization/workspace RLS installed for the workspace-host graph',
  where: 'PL/pgSQL function inline_code_block line 44 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 980-personal-vault-account-provenance.sql
[with-test-pg] pg apply 981-session-task-engine.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "session_tasks_workspace_isolation" for relation "harness_shared.session_tasks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 982-session-task-work-item-links.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "session_task_work_item_links_workspace_isolation" for relation "harness_shared.session_task_work_item_links" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 983-personal-vault-import-jobs.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "personal_vault_import_jobs_workspace_isolation" for relation "harness_shared.personal_vault_import_jobs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "personal_vault_import_uploads_workspace_isolation" for relation "harness_shared.personal_vault_import_uploads" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 985-p2p-foreign-workspaces-change-notify.sql
[with-test-pg] pg apply 986-resource-governor-work-item-queue-identity.sql
[with-test-pg] pg apply 987-bulk-review-owner-dismissed-outcome.sql
[with-test-pg] pg apply 988-work-item-dependency-delete-guard.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_items_dependency_endpoint_delete_guard_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 990-memory-write-journal-shareable.sql
[with-test-pg] pg apply 991-work-item-dependency-lifecycle-transition-guard.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_items_dependency_lifecycle_guard_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 992-work-item-dependency-satisfaction.sql
[with-test-pg] pg apply 994-work-item-dependency-resync-contention-guard.sql
[with-test-pg] pg apply 995-work-item-completion-settlement-manifest.sql
[with-test-pg] pg apply 996-work-item-completion-settlement-readiness.sql
[with-test-pg] pg apply 997-hosted-app-role-membership.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'role "harness_app" has already been granted membership in role "hosted_app" by role "postgres"',
  where: 'SQL statement "GRANT hosted_app TO harness_app WITH SET TRUE"\n' +
    'PL/pgSQL function inline_code_block line 44 at EXECUTE',
  file: 'user.c',
  line: '1892',
  routine: 'AddRoleMems'
}
[with-test-pg] pg apply 999-personal-vault-import-failed-entries.sql
[with-test-pg] pg apply 1002-workos-sealed-session-vault.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "papercusp_auth" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workos_sealed_sessions_service_all" for relation "papercusp_auth.workos_sealed_sessions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1003-work-item-sequence-federation-floor.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_items_advance_id_sequence" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1004-acceptance-rubric-subject-uniqueness.sql
[with-test-pg] pg apply 1005-hosted-service-lifecycle-runtime.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'role "harness_app" has already been granted membership in role "hosted_service" by role "postgres"',
  where: 'SQL statement "GRANT hosted_service TO harness_app WITH SET TRUE"\n' +
    'PL/pgSQL function inline_code_block line 37 at EXECUTE',
  file: 'user.c',
  line: '1892',
  routine: 'AddRoleMems'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_sessions_service_all" for relation "papercusp_auth.hosted_sessions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "webhook_event_receipts_service_all" for relation "papercusp_auth.webhook_event_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "workos_lifecycle_entity_cursors_service_all" for relation "papercusp_auth.workos_lifecycle_entity_cursors" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1006-backup-snapshot-db-dump-integrity.sql
[with-test-pg] pg apply 1009-hosted-workspace-reverse-connectors.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_workspace_connectors_service_all" for relation "papercusp_auth.hosted_workspace_connectors" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_workspace_connector_tickets_service_all" for relation "papercusp_auth.hosted_workspace_connector_tickets" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1010-hosted-provider-delegation-metadata.sql
[with-test-pg] pg apply 1012-gym-durable-active-task-generation.sql
[with-test-pg] pg apply 1013-hosted-workspace-lifecycle-policy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "customer_workspaces_tenant_concurrency_ck" of relation "customer_workspaces" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "customer_workspaces_provider_concurrency_ck" of relation "customer_workspaces" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "customer_workspaces_lifecycle_budget_ck" of relation "customer_workspaces" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "customer_workspaces_billing_owner_ck" of relation "customer_workspaces" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "customer_workspaces_idle_stop_ck" of relation "customer_workspaces" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "workspace_host_operations_customer_workspace_fk" of relation "workspace_host_operations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "workspace_host_operations_tenant_identity_ck" of relation "workspace_host_operations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "workspace_host_operations_cost_provenance_ck" of relation "workspace_host_operations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "workspace_host_operations_billing_owner_ck" of relation "workspace_host_operations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "workspace_host_operations_risk_ck" of relation "workspace_host_operations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "workspace_host_operations_approval_ck" of relation "workspace_host_operations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "workspace_host_operations_recovery_ck" of relation "workspace_host_operations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "workspace_host_operations_emergency_teardown_ck" of relation "workspace_host_operations" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1014-testing-run-snapshots.sql
[with-test-pg] pg apply 1015-bulk-resolve-dispositions-and-confidence.sql
[with-test-pg] pg apply 1016-trigger-direct-work-item.sql
[with-test-pg] pg apply 1017-su-session-persistence.sql
[with-test-pg] pg apply 1020-retire-cross-harness-legacy-needs-human-residue.sql
[with-test-pg] pg apply 1021-repair-per-harness-feature-view-filter.sql
[with-test-pg] pg apply 1022-gateway-payload-spool-blobs.sql
[with-test-pg] pg apply 1023-pui-session-runtime-class.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '1023: replaced 0 per-harness agent_chats views, skipped 0',
  where: 'PL/pgSQL function inline_code_block line 50 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 1024-plan-is-blender-origin-generated-column.sql
[with-test-pg] pg apply 1025-governor-receipts-skip-federation-capture.sql
[with-test-pg] pg apply 1026-governor-receipts-skip-sync-notify.sql
[with-test-pg] pg apply 1027-desktop-kind-kasmvnc.sql
[with-test-pg] pg apply 1028-admission-runs-durable-park-audit-run-kind.sql
[with-test-pg] pg apply 1029-app-owner-mappings.sql
[with-test-pg] pg apply 1030-repair-missing-indexes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "code_recipes_runcount_idx" already exists, skipping',
  file: 'index.c',
  line: '894',
  routine: 'index_create'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "decision_ledger_ws_posture_idx" already exists, skipping',
  file: 'index.c',
  line: '894',
  routine: 'index_create'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "test_runs_branch_idx" already exists, skipping',
  file: 'index.c',
  line: '894',
  routine: 'index_create'
}
[with-test-pg] pg apply 1032-agent-mode-goal-holder-election.sql
[with-test-pg] pg apply 1033-fleet-assignment-exclude-resource-governor-receipts.sql
[with-test-pg] pg apply 1036-fix-worked-history-trigger-order.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_items_worked_by_history_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1037-work-item-first-claim-stamp.sql
[with-test-pg] pg apply 1038-coord-event-log-fed-event-key-idx.sql
[with-test-pg] pg apply 1039-learning-pot-scope.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "learning_pot_scope_workspace_isolation" for relation "harness_shared.learning_pot_scope" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1040-cloud-resource-obligations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "cloud_resource_obligations_workspace_isolation" for relation "harness_shared.cloud_resource_obligations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1041-expose-release-columns-on-engineer-issues-view.sql
[with-test-pg] pg apply 1042-reconcile-orphan-pot-learning-rows.sql
[with-test-pg] pg apply 1043-tool-invocations-serving-host-identity.sql
[with-test-pg] pg apply 1044-completion-identity-multi-repo-artifact-floor.sql
[with-test-pg] pg apply 1045-agent-display-names.sql
[with-test-pg] pg apply 1046-in-process-sweep-arm-tier.sql
[with-test-pg] pg apply 1047-spawn-governor-observation.sql
[with-test-pg] pg apply 1048-tool-invocation-goal-actor-provenance.sql
[with-test-pg] pg apply 1049-plan-status-awaiting-acceptance.sql
[with-test-pg] pg apply 1053-coord-event-log-unanswered-directed-idx.sql
[with-test-pg] pg apply 1054-pipeline-events-gate-fire-kind.sql
[with-test-pg] pg apply 1055-work-item-release-cooldown-sidecar.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "work_item_release_cooldowns_workspace_isolation" for relation "harness_shared.work_item_release_cooldowns" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1057-attention-standing-automation-policy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_attention_automation_policy_workspace_isolation" for relation "harness_shared.operator_attention_automation_policy" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1058-plan-cleanup-enlist-plan-finding.sql
[with-test-pg] pg apply 1062-resource-governor-admission-ledger.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "reject_post_cutover_governor_work_item_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1063-attention-bulk-item-reversal-window.sql
[with-test-pg] pg apply 1064-reclassify-pre-watchdog-complete-runs.sql
[with-test-pg] pg apply 1065-fleet-park-resume-path.sql
[with-test-pg] pg apply 1066-coord-escalation-reopen-compensation.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "coord_open_escalations" already exists, skipping',
  file: 'parse_utilcmd.c',
  line: '211',
  routine: 'transformCreateStmt'
}
[with-test-pg] pg apply 1067-resource-governor-cutover-collision-guard.sql
[with-test-pg] pg apply 1070-plan-item-sibling-claim-floor.sql
[with-test-pg] pg apply 1071-restore-plan-items-owner-gate-marker-after-1059-collision.sql
[with-test-pg] pg apply 1072-plan-assignment-claim-floor.sql
[with-test-pg] pg apply 1074-session-prompt-origin-stamps.sql
[with-test-pg] pg apply 1075-agent-mode-implication-provenance.sql
[with-test-pg] pg apply 1076-resource-governor-retired-writer-guard.sql
[with-test-pg] pg apply 1081-plan-route-decision-claim-floor.sql
[with-test-pg] pg apply 1082-drop-unused-work-items-see-also-gin.sql
[with-test-pg] pg apply 1083-pipeline-events-gate-fire-drill-kind.sql
[with-test-pg] pg apply 1087-align-blocker-ref-indexability.sql
[with-test-pg] pg apply 1089-fix-stale-terminal-close-guidance.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '1089: migration 797 terminal guard is not installed — no stale guidance needs repair; no-op',
  where: 'PL/pgSQL function inline_code_block line 45 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 1091-resolver-whole-corpus-run-kind.sql
[with-test-pg] pg apply 1092-add-operator-announced-quiesce-state.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_announced_quiesce_state_workspace_isolation" for relation "harness_shared.operator_announced_quiesce_state" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1093-memory-vec-row-kind-partial-hnsw.sql
[with-test-pg] pg apply 1094-coord-open-escalations-trigger-update-fix.sql
[with-test-pg] pg apply 1095-substrate-outbox-table-drain-idx.sql
[with-test-pg] pg apply 1096-engineer-issues-view-expose-ei-payload.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: "1096: patched engineer_issues.payload to project the full payload (was payload - '_ei')",
  where: 'PL/pgSQL function inline_code_block line 27 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '1096: verified — 0 rows expose `_ei` through both the base table and the view; both severity accessors now agree',
  where: 'PL/pgSQL function inline_code_block line 74 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 1097-carry-notes-coord-thread-posts-prose-index.sql
[with-test-pg] pg apply 1098-drop-bak-20260717-unify-restore-tables.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "bak_20260717_unify_work_items" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "bak_20260717_unify_links" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "bak_20260717_unify_threads" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "bak_20260717_unify_posts" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "bak_20260717_unify_subs" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'table "bak_20260717_unify_topics" does not exist, skipping',
  file: 'tablecmds.c',
  line: '1497',
  routine: 'DropErrorMsgNonExistent'
}
[with-test-pg] pg apply 1100-claim-floors-parallel-safe.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'work_item_claim_floors*: marked 8 function(s) PARALLEL SAFE',
  where: 'PL/pgSQL function inline_code_block line 17 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 1101-fix-claim-floors-blocked-dep-seqscan.sql
[with-test-pg] pg apply 1102-workspace-host-health-status-unknown.sql
[with-test-pg] pg apply 1103-scorecard-obs-expr-indexes-realign.sql
[with-test-pg] pg apply 1104-doc-parts-stack-scope.sql
[with-test-pg] pg apply 1105-add-plugin-slug-indexes.sql
[with-test-pg] pg apply 1107-plan-revisions-content-snapshot-hash.sql
[with-test-pg] pg apply 1108-learning-sync-push-invalidation.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "learning_frontier_change_notify_upsert_trg" for relation "harness_shared.routines" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "learning_frontier_change_notify_delete_trg" for relation "harness_shared.routines" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1109-close-sync-trigger-coverage-gaps.sql
[with-test-pg] pg apply 1110-work-items-admission-flags-generated-columns.sql
[with-test-pg] pg apply 1111-acceptance-bar-contract-seed.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "harness_plans_stamp_acceptance_bar_epoch" for relation "harness_shared.harness_plans" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1112-prevent-resolved-escalation-projection-resurrection.sql
[with-test-pg] pg apply 1114-activity-report-session-lookup-index.sql
[with-test-pg] pg apply 1115-gym-candidate-version-verdict.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "task_corpus" of relation "gym_proposals" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
[with-test-pg] pg apply 1116-learning-spend-reservations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "learning_spend_reservations_workspace_isolation" for relation "harness_shared.learning_spend_reservations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1117-session-turns-chunked-at.sql
[with-test-pg] pg apply 1118-carry-note-unchanged-attestation.sql
[with-test-pg] pg apply 1119-harness-slug-usage-attribution.sql
[with-test-pg] pg apply 1120-codex-iso-harness-attribution.sql
[with-test-pg] pg apply 1121-goal-id-codex-adv-attribution.sql
[with-test-pg] pg apply 1122-substrate-merge-cursor-apply-failure.sql
[with-test-pg] pg apply 1123-session-turn-verdict-comment-persisted-set.sql
[with-test-pg] pg apply 1125-frozen-repair-edit-ledger.sql
[with-test-pg] pg apply 1126-hosted-two-tenant-boundary-repair.sql
[with-test-pg] pg apply 1127-workspace-host-domain-contracts.sql
[with-test-pg] pg apply 1130-canonicalize-session-part-tool-names.sql
[with-test-pg] pg apply 1131-substrate-outbox-enqueue-age.sql
[with-test-pg] pg apply 1132-executed-source-map.sql
[with-test-pg] pg apply 1134-observation-lane-off-hive-log.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "capture_work_items_outbox_ins_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "capture_work_items_outbox_del_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1135-work-items-epoch-ms-timestamp-guard.sql
[with-test-pg] pg apply 1136-tool-invocations-adv-session-lookup-index.sql
[with-test-pg] pg apply 1138-issue-claim-expected-holder-cas.sql
[with-test-pg] pg apply 1140-capability-class-registry.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "capability_class_registry_workspace_isolation" for relation "harness_shared.capability_class_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "capability_class_registry_approved_global_read" for relation "harness_shared.capability_class_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "capability_class_conformance_workspace_isolation" for relation "harness_shared.capability_class_conformance_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "capability_class_provider_workspace_isolation" for relation "harness_shared.capability_class_provider_bindings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "pot_capability_class_bindings_workspace_isolation" for relation "harness_shared.pot_capability_class_bindings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1141-enforce-capability-class-passing-bindings.sql
[with-test-pg] pg apply 1142-plan-decision-affects-authority.sql
[with-test-pg] pg apply 1144-completion-identity-deletion-artifact-floor.sql
[with-test-pg] pg apply 1147-testing-run-snapshot-task-link.sql
[with-test-pg] pg apply 1149-session-identity-activation-spans.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "session_identity_activation_workspace_isolation" for relation "harness_shared.session_identity_activation_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1150-test-runs-execution-details.sql
[with-test-pg] pg apply 1151-coord-open-escalations-subject-index.sql
[with-test-pg] pg apply 1152-code-recipes-embedding-hnsw.sql
[with-test-pg] pg apply 1153-test-runs-mutation-probe-source.sql
[with-test-pg] pg apply 1154-prose-embedding-profile-identity.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "text_embedding_mode" of relation "session_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "session_turn_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "text_embedding_mode" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "doc_sections" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "harness_docs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "harness_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_mode" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content_embedding_mode" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_mode" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "personal_documents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "note_embedding_mode" of relation "carry_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_mode" of relation "coord_thread_posts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "work_items" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
[with-test-pg] pg apply 1155-reapply-safe-prose-embedding-profile-identity.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "text_embedding_mode" of relation "session_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "text_embedding_profile" of relation "session_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "session_turn_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "session_turn_chunks" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "text_embedding_mode" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "text_embedding_profile" of relation "operator_turns" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "doc_sections" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "doc_sections" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "harness_docs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "harness_docs" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "harness_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "harness_plans" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_mode" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_profile" of relation "harness_escalations" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content_embedding_mode" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "content_embedding_profile" of relation "harness_brainstorm" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_mode" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_profile" of relation "harness_decisions" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "code_recipes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "code_recipes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "datatype_registry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "datatype_registry" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "personal_documents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "personal_documents" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "query_embedding_mode" of relation "consult_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "query_embedding_profile" of relation "consult_state" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "interest_watches" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "interest_watches" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "note_embedding_mode" of relation "carry_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "note_embedding_profile" of relation "carry_notes" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_mode" of relation "coord_thread_posts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "body_embedding_profile" of relation "coord_thread_posts" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_mode" of relation "work_items" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42701',
  message: 'column "embedding_profile" of relation "work_items" already exists, skipping',
  file: 'tablecmds.c',
  line: '7682',
  routine: 'check_for_column_name_collision'
}
[with-test-pg] pg apply 1156-agent-chat-continuation-lineage.sql
[with-test-pg] pg apply 1157-work-items-keyless-title-identity-guard.sql
[with-test-pg] pg apply 1159-backfill-expired-consult-conversation-lifecycle.sql
[with-test-pg] pg apply 1161-capability-class-embedding-profile.sql
[with-test-pg] pg apply 1162-tool-invocations-spawn-tree-spawn-id-filter.sql
[with-test-pg] pg apply 1166-report-library.sql
[with-test-pg] pg apply 1167-gate-repair-latency-ledger-kind.sql
[with-test-pg] pg apply 1168-cloud-resource-obligation-addressability.sql
[with-test-pg] pg apply 1169-event-reactions-contributor.sql
[with-test-pg] pg apply 1170-event-key-registry.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "event_key_registry_workspace_isolation" for relation "harness_shared.event_key_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "event_key_registry_approved_global_read" for relation "harness_shared.event_key_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1171-event-key-payload-schema.sql
[with-test-pg] pg apply 1172-grant-harness-app-dbos-workflow-status-read.sql
[with-test-pg] pg apply 1173-plan-items-parts-change-notify.sql
[with-test-pg] pg apply 1174-spec-evidence-binding-retraction.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "spec_evidence_bindings_retraction_complete" of relation "spec_evidence_bindings" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1175-spec-evidence-dedup-partial-on-live.sql
[with-test-pg] pg apply 1176-spec-evidence-drop-total-dedup-contract-phase.sql
[with-test-pg] pg apply 1177-identity-usage-carry-correlation.sql
[with-test-pg] pg apply 1178-sync-trigger-coverage-dream-and-identity.sql
[with-test-pg] pg apply 1180-completion-identity-out-of-repo-artifact-floor-followup.sql
[with-test-pg] pg apply 1181-conversation-plan-work-item-provenance.sql
[with-test-pg] pg apply 1182-session-port-atomic-attempts.sql
[with-test-pg] pg apply 1183-pg-query-advisory-fires.sql
[with-test-pg] pg apply 1185-session-gate-decide-by-and-asker-gone.sql
[with-test-pg] pg apply 1186-owner-directive-pending-state.sql
[with-test-pg] pg apply 1187-owner-directive-capture-provenance.sql
[with-test-pg] pg apply 1188-hosted-self-signup.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "papercusp_auth" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_signup_attempts_service_all" for relation "papercusp_auth.hosted_signup_attempts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_entitlements_service_all" for relation "papercusp_auth.hosted_entitlements" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_memberships_signup_owner" for relation "papercusp_auth.organization_memberships" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "organization_memberships_signup_owner_read" for relation "papercusp_auth.organization_memberships" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "legal_acceptances_signup_owner" for relation "papercusp_auth.legal_acceptances" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1189-owner-directive-capture-promoted-note.sql
[with-test-pg] pg apply 1190-psu-pty-host-events.sql
[with-test-pg] pg apply 1191-hosted-self-signup-legal-acceptances-select-grant.sql
[with-test-pg] pg apply 1192-orientation-class-telemetry.sql
[with-test-pg] pg apply 1193-hosted-workspace-admission-control-plane-grant.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "customer_workspaces_local_workspace_isolation" for relation "harness_shared.customer_workspaces" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1194-work-items-directive-ref.sql
[with-test-pg] pg apply 1195-directive-capture-per-session.sql
[with-test-pg] pg apply 1196-owner-directive-unstick-dispositioned-pending-captures.sql
[with-test-pg] pg apply 1197-work-items-twin-marker-indexes.sql
[with-test-pg] pg apply 1198-owner-directive-every-turn-open-and-summary.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "owner_directives_normalize_capture" for relation "harness_shared.owner_directives" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1199-work-items-acceptance-drain-plan-index.sql
[with-test-pg] pg apply 1200-customer-workspaces-one-live-per-organization.sql
[with-test-pg] pg apply 1201-owner-directive-reopen.sql
[with-test-pg] pg apply 1202-consult-expert-routing-settings.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_consult_expert_routing_workspace_isolation" for relation "harness_shared.operator_consult_expert_routing" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1203-hosted-session-reauthentication.sql
[with-test-pg] pg apply 1204-interactive-usage-parser-state-cache-tiers.sql
[with-test-pg] pg apply 1205-interactive-usage-request-provenance.sql
[with-test-pg] pg apply 1206-substrate-merge-cursor-snapshot-apply-mark.sql
[with-test-pg] pg apply 1207-completion-identity-history-attestation-floor.sql
[with-test-pg] pg apply 1208-engineer-issue-wire-row-drives-stamp-clock.sql
[with-test-pg] pg apply 1209-hosted-cli-device-sign-in.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_cli_device_grants_service_all" for relation "papercusp_auth.hosted_cli_device_grants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_cli_tokens_service_all" for relation "papercusp_auth.hosted_cli_tokens" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1210-operator-embed-device.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "operator_embed_device_workspace_isolation" for relation "harness_shared.operator_embed_device" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1211-cloud-resource-obligation-incarnation.sql
[with-test-pg] pg apply 1212-blueprint-specification-snapshots.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "blueprint_specifications_workspace_isolation" for relation "harness_shared.blueprint_specifications" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1213-sync-notify-coalesce-bulk-fold.sql
[with-test-pg] pg apply 1214-work-item-completion-event-intent.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "zz_work_item_completion_event_intent_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1215-event-await-delivery-intent-recovery-index.sql
[with-test-pg] pg apply 1216-event-await-fired-delivery-intent-marker.sql
[with-test-pg] pg apply 1217-adv-session-launch-parent-projection.sql
[with-test-pg] pg apply 1218-work-item-floor-lockfree-fast-path.sql
[with-test-pg] pg apply 1219-blueprint-operation-invocations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "blueprint_operation_invocations_workspace_isolation" for relation "harness_shared.blueprint_operation_invocations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1220-scheduled-blueprint-invocation-payload.sql
[with-test-pg] pg apply 1221-plan-run-replay-context.sql
[with-test-pg] pg apply 1223-blueprint-operation-event-replay.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "blueprint_work_item_event_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "blueprint_plan_run_event_trg" for relation "harness_shared.plan_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1224-learning-reservation-resources.sql
[with-test-pg] pg apply 1225-consult-dispatch-attempts.sql
[with-test-pg] pg apply 1226-feature-wire-row-drives-stamp-clock.sql
[with-test-pg] pg apply 1227-work-items-derive-before-fed-stamp.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_before_fed_work_item_closed_ts_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_before_fed_work_item_completion_event_intent_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "stamp_before_fed_work_item_state_changed_at_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1228-blueprint-operation-automation-bindings.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_bindings_blueprint_operation_action_check" of relation "trigger_bindings" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1229-rubric-amend-shared-receipts.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "rubric_amend_receipts_workspace_isolation" for relation "harness_shared.rubric_amend_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1230-blueprint-package-resource-receipts.sql
[with-test-pg] pg apply 1231-memory-managed-write-fences.sql
[with-test-pg] pg apply 1232-blueprint-package-installations.sql
[with-test-pg] pg apply 1233-capability-provider-execution-kind.sql
[with-test-pg] pg apply 1234-host-kernel-memory-samples.sql
[with-test-pg] pg apply 1235-coord-event-log-escalation-reroute-of-idx.sql
[with-test-pg] pg apply 1236-test-executed-sources-reuse-inputs.sql
[with-test-pg] pg apply 1237-blueprint-invocation-program-started.sql
[with-test-pg] pg apply 1238-desktop-perf-runs-build-sha.sql
[with-test-pg] pg apply 1239-capability-class-cupboard-provenance.sql
[with-test-pg] pg apply 1240-agent-facts-recheck-exec.sql
[with-test-pg] pg apply 1241-engineer-issue-wire-row-preserve-payload-nulls.sql
[with-test-pg] pg apply 1242-text-chunks.sql
[with-test-pg] pg apply 1243-drop-carry-notes-embedding.sql
[with-test-pg] pg apply 1244-connected-apps.sql
[with-test-pg] pg apply 1245-doc-parts-package-address.sql
[with-test-pg] pg apply 1246-decision-model-calls.sql
[with-test-pg] pg apply 1247-su-client-lease.sql
[with-test-pg] pg apply 1248-connected-app-device-grants.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "connected_app_device_grants_workspace_isolation" for relation "harness_shared.connected_app_device_grants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1249-drop-unread-harness-docs-thread-post-embeddings.sql
[with-test-pg] pg apply 1250-predicate-watch-evaluator-baselines.sql
[with-test-pg] pg apply 1251-identity-hook-turns.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "identity_hook_turns_workspace" for relation "harness_shared.identity_hook_turns" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1252-connected-app-service-keys.sql
[with-test-pg] pg apply 1253-identity-hook-turns-ms-spent.sql
[with-test-pg] pg apply 1254-hosted-app-relay-usage.sql
[with-test-pg] pg apply 1255-hosted-app-relay-usage-grants.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_app_relay_usage_service_all" for relation "papercusp_auth.hosted_app_relay_usage" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1256-connected-app-mcp-oauth.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "connected_app_device_grants_oauth_request_complete" of relation "connected_app_device_grants" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "connected_app_device_grants_auth_code_shape" of relation "connected_app_device_grants" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "connected_app_device_grants_granted_scopes_is_object" of relation "connected_app_device_grants" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1257-coord-entity-subscriptions-allow-muted.sql
[with-test-pg] pg apply 1258-acceptance-bar-verified-revision.sql
[with-test-pg] pg apply 1259-memory-precision-bench-attempts.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "memory_precision_bench_attempts_workspace_isolation" for relation "harness_shared.memory_precision_bench_attempts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1260-hosted-mcp-oauth.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_mcp_oauth_clients_service_all" for relation "papercusp_auth.hosted_mcp_oauth_clients" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_mcp_oauth_requests_service_all" for relation "papercusp_auth.hosted_mcp_oauth_requests" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1261-connected-app-client-credentials.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "connected_apps_client_auth_check" of relation "connected_apps" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.connected_apps\n' +
    '    DROP CONSTRAINT IF EXISTS connected_apps_client_auth_check,\n' +
    '    ADD CONSTRAINT connected_apps_client_auth_check CHECK (\n' +
    '      client_auth IS NULL\n' +
    "      OR (kind = 'service' AND client_auth IN ('client_secret', 'private_key_jwt'))\n" +
    '    )"\n' +
    'PL/pgSQL function inline_code_block line 12 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "connected_apps_client_jwk_check" of relation "connected_apps" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.connected_apps\n' +
    '    DROP CONSTRAINT IF EXISTS connected_apps_client_jwk_check,\n' +
    '    ADD CONSTRAINT connected_apps_client_jwk_check CHECK (\n' +
    "      CASE WHEN client_auth IS NOT DISTINCT FROM 'private_key_jwt'\n" +
    "           THEN client_jwk IS NOT NULL AND jsonb_typeof(client_jwk) = 'object'\n" +
    '           ELSE client_jwk IS NULL\n' +
    '      END\n' +
    '    )"\n' +
    'PL/pgSQL function inline_code_block line 22 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1262-remote-access-own-tunnel.sql
[with-test-pg] pg apply 1263-connected-app-access-settings.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "connected_app_access_settings_workspace_isolation" for relation "harness_shared.connected_app_access_settings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1264-connected-apps-change-notify.sql
[with-test-pg] pg apply 1265-connected-app-spend-and-alerts.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "connected_app_networks_workspace_isolation" for relation "harness_shared.connected_app_networks" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1266-text-chunks-parent-key-stats.sql
[with-test-pg] pg apply 1267-connected-app-alert-sweep.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "connected_app_auth_failures_workspace_isolation" for relation "harness_shared.connected_app_auth_failures" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1268-portal-relay-linked-installs.sql
[with-test-pg] pg apply 1269-webhook-trigger-secrets.sql
[with-test-pg] pg apply 1270-identity-funding-bindings.sql
[with-test-pg] pg apply 1271-learning-pot-scope-pause-provenance.sql
[with-test-pg] pg apply 1272-drop-mobile-devices-shim-view.sql
[with-test-pg] pg apply 1273-session-turns-trigram-exact-fuzzy-index.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42710',
  message: 'extension "pg_trgm" already exists, skipping',
  file: 'extension.c',
  line: '2120',
  routine: 'CreateExtension'
}
[with-test-pg] pg apply 1274-event-await-standing-exact-key-index.sql
[with-test-pg] pg apply 1275-identity-attribution-indexed-spans.sql
[with-test-pg] pg apply 1276-hosted-billing-subscriptions.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "papercusp_auth" already exists, skipping',
  file: 'schemacmds.c',
  line: '135',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_billing_customers_service_all" for relation "papercusp_auth.hosted_billing_customers" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_subscriptions_service_all" for relation "papercusp_auth.hosted_subscriptions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_billing_webhook_events_service_all" for relation "papercusp_auth.hosted_billing_webhook_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1278-identity-learning-candidates.sql
[with-test-pg] pg apply 1279-plan-shipment-acceptance-gate-receipt.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "harness_plans_require_shipment_acceptance_gate_receipt" for relation "harness_shared.harness_plans" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1280-agent-usage-price-table-version.sql
[with-test-pg] pg apply 1281-agent-usage-price-version-idx.sql
[with-test-pg] pg apply 1282-blueprint-receipt-target-harness-slug.sql
[with-test-pg] pg apply 1283-ledger-chain-links.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "ledger_chain_links_append_only_trg" for relation "harness_shared.ledger_chain_links" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "ledger_chain_links_workspace_isolation" for relation "harness_shared.ledger_chain_links" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1284-plan-closure-observations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_closure_observations_workspace_isolation" for relation "harness_shared.plan_closure_observations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1285-decision-model-calls-surface.sql
[with-test-pg] pg apply 1286-money-journal.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "money_journal_entries_append_only_trg" for relation "harness_shared.money_journal_entries" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "money_journal_lines_append_only_trg" for relation "harness_shared.money_journal_lines" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "money_journal_micro_accruals_append_only_trg" for relation "harness_shared.money_journal_micro_accruals" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "money_journal_entries_balance_trg" for relation "harness_shared.money_journal_entries" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "money_journal_lines_balance_trg" for relation "harness_shared.money_journal_lines" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "money_journal_entries_workspace_isolation" for relation "harness_shared.money_journal_entries" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS money_journal_entries_workspace_isolation ON harness_shared.money_journal_entries"\n' +
    'PL/pgSQL function inline_code_block line 8 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "money_journal_lines_workspace_isolation" for relation "harness_shared.money_journal_lines" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS money_journal_lines_workspace_isolation ON harness_shared.money_journal_lines"\n' +
    'PL/pgSQL function inline_code_block line 8 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "money_journal_rollups_workspace_isolation" for relation "harness_shared.money_journal_rollups" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS money_journal_rollups_workspace_isolation ON harness_shared.money_journal_rollups"\n' +
    'PL/pgSQL function inline_code_block line 8 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "money_journal_micro_accruals_workspace_isolation" for relation "harness_shared.money_journal_micro_accruals" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS money_journal_micro_accruals_workspace_isolation ON harness_shared.money_journal_micro_accruals"\n' +
    'PL/pgSQL function inline_code_block line 8 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1287-dedupe-claude-transcript-usage-copies.sql
[with-test-pg] pg apply 1288-restore-run-instance-bar-epoch-exemption.sql
[with-test-pg] pg apply 1289-ledger-anchor.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "ledger_anchor_leaves_contiguous_trg" for relation "harness_shared.ledger_anchor_leaves" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "ledger_anchor_leaves_append_only_trg" for relation "harness_shared.ledger_anchor_leaves" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "ledger_anchors_append_only_trg" for relation "harness_shared.ledger_anchors" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "ledger_anchor_leaves_workspace_isolation" for relation "harness_shared.ledger_anchor_leaves" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "ledger_anchors_workspace_isolation" for relation "harness_shared.ledger_anchors" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1291-reconciliation.sql
[with-test-pg] pg apply 1292-sweep-claude-transcript-usage-copies.sql
[with-test-pg] pg apply 1293-provider-message-usage-key-check.sql
[with-test-pg] pg apply 1294-work-item-readiness-payload-projections.sql
[with-test-pg] pg apply 1295-activation-event-specification-layer-refs.sql
[with-test-pg] pg apply 1296-bulk-run-intake-decision.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "attention_bulk_run_items_intake_decision_check" of relation "attention_bulk_run_items" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1297-payment-receipts.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "payment_receipts_append_only_trg" for relation "harness_shared.payment_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "payment_receipts_workspace_isolation" for relation "harness_shared.payment_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1298-intake-promotion-key-unique.sql
[with-test-pg] pg apply 1299-statement-attestations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "statement_attestations_append_only_trg" for relation "harness_shared.statement_attestations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "statement_attestations_workspace_isolation" for relation "harness_shared.statement_attestations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1300-connected-app-removed-creators.sql
[with-test-pg] pg apply 1301-acceptance-claim-floor.sql
[with-test-pg] pg apply 1302-personal-disclosure-labels.sql
[with-test-pg] pg apply 1303-personal-disclosure-labels-rls.sql
[with-test-pg] pg apply 1304-hosted-tutorial-preferences-scope.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_preferences_user_scope" for relation "papercusp_auth.hosted_user_preferences" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1305-bulk-run-kind-intake-triage.sql
[with-test-pg] pg apply 1306-trigger-deliveries-payload-once.sql
[with-test-pg] pg apply 1307-personal-sealed-contents.sql
[with-test-pg] pg apply 1308-work-items-severity-projection.sql
[with-test-pg] pg apply 1309-workspace-host-absent-observed-revision-backfill.sql
[with-test-pg] pg apply 1310-acceptance-adoption-runs.sql
[with-test-pg] pg apply 1311-test-runs-execution-details-unwrap.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "test_runs_unwrap_execution_details" for relation "harness_shared.test_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1312-memory-canonical-hot-surfaced-bump.sql
[with-test-pg] pg apply 1313-plan-closure-observations-rubric-grader.sql
[with-test-pg] pg apply 1314-gateway-payload-chunks.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "gateway_payload_blobs_chunked_has_no_inline_bytes" of relation "gateway_payload_blobs" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1315-cloud-resource-obligations-aws-provider.sql
[with-test-pg] pg apply 1316-documents-corpus-scope-permissions.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "personal_documents_scope_chk" of relation "personal_documents" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "personal_documents_pot_slug_chk" of relation "personal_documents" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "personal_documents_permission_list_fk" of relation "personal_documents" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1317-data-source-record.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "trigger_sources_apply_kind_defaults" for relation "harness_shared.trigger_sources" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_sync_mode_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_backfill_status_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_scope_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_scope_ref_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_scope_mapping_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_datatype_mappings_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_destination_policy_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_retention_policy_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_permission_mapping_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "trigger_sources_personal_owner_chk" of relation "trigger_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1318-datatype-nature.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "datatype_registry_fill_legacy_nature" for relation "harness_shared.datatype_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "datatype_registry_nature_check" of relation "datatype_registry" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "datatype_registry_audience_check" of relation "datatype_registry" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1319-decision-model-calls-loop-busy.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "decision_model_calls_loop_busy_range" of relation "decision_model_calls" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1320-chat-retrieval-units.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "chat_messages_enforce_legal_hold" for relation "harness_shared.chat_messages" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1321-data-source-subscriptions.sql
[with-test-pg] pg apply 1322-work-items-nature.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "nature_stamp_from_registry_trg" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "restamp_work_items_nature_trg" for relation "harness_shared.datatype_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "work_items_nature_check" of relation "work_items" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "work_items_audience_check" of relation "work_items" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1323-work-items-views-nature.sql
[with-test-pg] pg apply 1324-rename-trigger-sources-to-data-sources.sql
[with-test-pg] pg apply 1325-work-item-is-agent-work.sql
[with-test-pg] pg apply 1326-chat-rollup-requeue-on-source-routing-change.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "data_sources_requeue_chat_buckets" for relation "harness_shared.data_sources" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1327-rename-personal-documents-to-documents.sql
[with-test-pg] pg apply 1328-work-item-completion-intent-local-close-only.sql
[with-test-pg] pg apply 1329-claim-retractions.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "claim_retraction_events_workspace_isolation" for relation "harness_shared.claim_retraction_events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1331-goal-lease-epoch-history.sql
[with-test-pg] pg apply 1332-ticket-datatypes.sql
[with-test-pg] pg apply 1333-slack-org-sync-routine.sql
[with-test-pg] pg apply 1334-session-turn-windows.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42710',
  message: 'extension "pg_trgm" already exists, skipping',
  file: 'extension.c',
  line: '2120',
  routine: 'CreateExtension'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "session_turn_windows_sync_trg" for relation "harness_shared.session_turns" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1335-decision-model-calls-transport-latency.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "decision_model_calls_transport_latency_range" of relation "decision_model_calls" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1336-github-issues-sync-routine.sql
[with-test-pg] pg apply 1337-work-admissions.sql
[with-test-pg] pg apply 1339-session-gate-suppressed-ask-kind.sql
[with-test-pg] pg apply 1340-session-brief-pending-carry-respawn.sql
[with-test-pg] pg apply 1341-text-chunks-consult-questions-hnsw.sql
[with-test-pg] pg apply 1342-pi-session-expiry-tool-allowlist.sql
[with-test-pg] pg apply 1344-completion-history-search-memo.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "completion_history_search_memo_workspace_isolation" for relation "harness_shared.completion_history_search_memo" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1345-edit-attribution-ledger-agent-ts-idx.sql
[with-test-pg] pg apply 1346-goal-mode-change-subject-backfill.sql
[with-test-pg] pg apply 1347-personal-disclosures-reader-window-idx.sql
[with-test-pg] pg apply 1348-fleet-leader-missing-since.sql
[with-test-pg] pg apply 1349-producer-learning-lifecycle-receipts.sql
[with-test-pg] pg apply 1351-hosted-usage-receipts.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_usage_receipts_service" for relation "papercusp_auth.hosted_usage_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hosted_usage_receipts_append_only" for relation "papercusp_auth.hosted_usage_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1352-hosted-budget-reservations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_budget_receipts_service" for relation "papercusp_auth.hosted_budget_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hosted_budget_receipts_guard" for relation "papercusp_auth.hosted_budget_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1353-report-library-goal-snapshot.sql
[with-test-pg] pg apply 1354-hosted-usage-exact-micros.sql
[with-test-pg] pg apply 1355-hosted-openrouter-generation-binding.sql
[with-test-pg] pg apply 1356-hosted-budget-exact-micros.sql
[with-test-pg] pg apply 1357-documents-datatype-id.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "documents_normalize_legacy_routing" for relation "harness_shared.documents" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1358-gym-durable-run-evidence.sql
[with-test-pg] pg apply 1359-data-sources-reconnect-required-status.sql
[with-test-pg] pg apply 1360-connector-sync-driver.sql
[with-test-pg] pg apply 1361-lsp-capability-matrix.sql
[with-test-pg] pg apply 1362-trigger-pack-installations.sql
[with-test-pg] pg apply 1363-adv-sessions-su-host-owner.sql
[with-test-pg] pg apply 1364-solo-decision-execution-reservation.sql
[with-test-pg] pg apply 1365-unify-work-item-dep-change-notify.sql
[with-test-pg] pg apply 1366-mapped-report-occurrence-change-notify.sql
[with-test-pg] pg apply 1367-edit-attribution-dispatch-call-id.sql
[with-test-pg] pg apply 1368-acceptance-claim-floor-kind-verification.sql
[with-test-pg] pg apply 1369-trigger-pack-review.sql
[with-test-pg] pg apply 1370-hosted-customer-rls-role-lock.sql
[with-test-pg] pg apply 1371-refresh-consolidated-views.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(agent_chats): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(agent_runs): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(directive_summaries): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(executed_actions): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(feature_audit): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(harness_issues): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(harness_snapshots): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(messages): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'refresh_consolidated_views(supervisor_notes): replaced 0, skipped 0, already current 0',
  where: 'PL/pgSQL function harness_shared.refresh_consolidated_views(text) line 71 at RAISE\n' +
    'SQL statement "SELECT *        FROM harness_shared.refresh_consolidated_views(b)"\n' +
    'PL/pgSQL function inline_code_block line 15 at SQL statement',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 1372-hosted-prepaid-allocations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_prepaid_allocations_service" for relation "papercusp_auth.hosted_prepaid_allocations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hosted_prepaid_allocations_guard" for relation "papercusp_auth.hosted_prepaid_allocations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1373-completion-verification-claim-floor.sql
[with-test-pg] pg apply 1374-gmail-provider-cutover.sql
[with-test-pg] pg apply 1375-hosted-stripe-funding-population.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "money_journal_entries_hosted_funding_read" for relation "harness_shared.money_journal_entries" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "money_journal_lines_hosted_funding_read" for relation "harness_shared.money_journal_lines" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "payment_receipts_hosted_funding_read" for relation "harness_shared.payment_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1376-plan-revisions-live-body-backfill.sql
[with-test-pg] pg apply 1377-ticket-workflow-tracker-fields.sql
[with-test-pg] pg apply 1378-preserve-spec-bound-test-runs.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "test_runs_preserve_spec_bound_evidence" for relation "harness_shared.test_runs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1379-retire-linear-jira-sync-plugins.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'schema "plugin_linear_sync" does not exist, skipping',
  file: 'dropcmds.c',
  line: '521',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'schema "plugin_jira_sync" does not exist, skipping',
  file: 'dropcmds.c',
  line: '521',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1380-admission-write-backs.sql
[with-test-pg] pg apply 1381-gcal-provider-cutover.sql
[with-test-pg] pg apply 1382-hosted-usage-population-lock.sql
[with-test-pg] pg apply 1383-relationship-graph-datatypes.sql
[with-test-pg] pg apply 1385-hosted-journal-liability-population.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "money_journal_rollups_hosted_funding_read" for relation "harness_shared.money_journal_rollups" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "money_journal_micro_accruals_hosted_funding_read" for relation "harness_shared.money_journal_micro_accruals" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1386-desktop-session-name.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: '1386: desktop_sessions.name installed; live-scope uniqueness is per (scope_ref, name)',
  where: 'PL/pgSQL function inline_code_block line 11 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 1387-admission-lifecycle.sql
[with-test-pg] pg apply 1388-hosted-budget-population-writer-fence.sql
[with-test-pg] pg apply 1389-plan-wide-route-a-claim-floor.sql
[with-test-pg] pg apply 1390-completion-history-attestation-v2-settlement-floor.sql
[with-test-pg] pg apply 1391-hosted-openrouter-budget-binding.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hosted_openrouter_budget_binding_guard" for relation "papercusp_auth.hosted_usage_receipts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1392-admission-rules-action.sql
[with-test-pg] pg apply 1393-interaction-sources-grant-person-record.sql
[with-test-pg] pg apply 1394-data-source-participant-backfill-marker.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "data_sources_reset_participant_backfill" for relation "harness_shared.data_sources" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1395-hold-interaction-person-grant.sql
[with-test-pg] pg apply 1396-completion-history-attestation-v2-refreshed-tree.sql
[with-test-pg] pg apply 1397-ticket-self-roles.sql
[with-test-pg] pg apply 1398-retire-probation-freshness-readiness-reasons.sql
[with-test-pg] pg apply 1399-ticket-integrations-change-notify.sql
[with-test-pg] pg apply 1400-connector-push-secrets.sql
[with-test-pg] pg apply 1401-operation-private-inputs.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "blueprint_operation_private_inputs_workspace_isolation" for relation "harness_shared.blueprint_operation_private_inputs" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1402-desktop-session-user-scope.sql
[with-test-pg] pg apply 1403-chat-bug-suggestions.sql
[with-test-pg] pg apply 1405-drop-session-turns-provenance-version-idx.sql
[with-test-pg] pg apply 1406-pr-review-reports-change-notify.sql
[with-test-pg] pg apply 1407-email-draft-proposal-agent-audience.sql
[with-test-pg] pg apply 1408-blueprint-agent-operation-placement.sql
[with-test-pg] pg apply 1409-work-admissions-outcome-chat-bugs-notify.sql
[with-test-pg] pg apply 1410-trigger-deliveries-chat-admission-failed-idx.sql
[with-test-pg] pg apply 1411-report-attachments.sql
[with-test-pg] pg apply 1412-connected-apps-noise-public-key.sql
[with-test-pg] pg apply 1413-restore-interaction-person-grant.sql
[with-test-pg] pg apply 1414-vault-mail-partition.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "documents_normalize_mail_partition" for relation "harness_shared.documents" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "personal_sync_state_normalize_mail_partition" for relation "harness_shared.personal_sync_state" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "personal_identity_aliases_normalize_mail_partition" for relation "harness_shared.personal_identity_aliases" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "personal_grants_normalize_mail_partition" for relation "harness_shared.personal_grants" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1415-participant-backfill-cursor.sql
[with-test-pg] pg apply 1417-account-tutorial-signup-enrollment.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_preferences_signup_owner" for relation "papercusp_auth.hosted_user_preferences" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1418-account-tutorial-membership-enrollment.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "new_membership_product_tutorial" for relation "papercusp_auth.organization_memberships" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1419-report-library-request-key.sql
[with-test-pg] pg apply 1420-report-library-operation-request-scope.sql
[with-test-pg] pg apply 1421-connected-app-service-zero-cap.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "connected_apps_spend_cap_nonnegative" of relation "connected_apps" does not exist, skipping',
  where: 'SQL statement "ALTER TABLE harness_shared.connected_apps\n' +
    '    DROP CONSTRAINT IF EXISTS connected_apps_spend_cap_positive,\n' +
    '    DROP CONSTRAINT IF EXISTS connected_apps_spend_cap_nonnegative,\n' +
    '    ADD CONSTRAINT connected_apps_spend_cap_nonnegative\n' +
    '      CHECK (spend_cap_cents IS NULL OR spend_cap_cents >= 0)"\n' +
    'PL/pgSQL function inline_code_block line 7 at SQL statement',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1422-adv-sessions-launch-harness-projection.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "adv_sessions_project_launch_harness" for relation "harness_shared.adv_sessions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1423-cupboard-funded-turn-ledger.sql
[with-test-pg] pg apply 1424-funded-turn-native-binding.sql
[with-test-pg] pg apply 1425-pipeline-events-gate-invariants-kind.sql
[with-test-pg] pg apply 1426-funded-tool-turn-state.sql
[with-test-pg] pg apply 1427-backfill-work-item-idea-origin.sql
[with-test-pg] pg apply 1428-cupboard-tool-funding-bindings.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "identity_release_funding_identity_pricing_check" of relation "identity_release_funding" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1429-route-invocation-metadata.sql
[with-test-pg] pg apply 1430-woe-worklist-only-picked-plans.sql
[with-test-pg] pg apply 1431-doc-section-order.sql
[with-test-pg] pg apply 1432-occurrence-flow-covering-index.sql
[with-test-pg] pg apply 1433-coord-event-log-delete-sync-invalidate.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_delete_trg" for relation "harness_shared.coord_event_log" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1434-benchmark-ungraded-archive-state.sql
[with-test-pg] pg apply 1435-agent-review-claim-next-index.sql
[with-test-pg] pg apply 1436-emit-change-notify-row-workspace.sql
[with-test-pg] pg apply 1438-normalize-plugin-config-updated-at-bigint.sql
[with-test-pg] pg apply 1439-session-ingest-short-user-turn-cutover.sql
[with-test-pg] pg apply 1440-bug-reproduction-revision-kind-backfill.sql
[with-test-pg] pg apply 1441-wake-delivery-turn-proof.sql
[with-test-pg] pg apply 1442-work-item-id-node-slots.sql
[with-test-pg] pg apply 1443-merge-same-workspace-work-item-twins.sql
[with-test-pg] pg apply 1444-work-items-unique-workspace-feature-id.sql
[with-test-pg] pg apply 1445-spec-evidence-independent-verification.sql
[with-test-pg] pg apply 1446-plan-contract-triage.sql
[with-test-pg] pg apply 1447-bm25-pg-textsearch-indexes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation work_items_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS work_items_bm25 ON harness_shared.work_items USING bm25 ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS work_items_bm25 ON harness_shared.work_items USING bm25 ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS work_items_bm25 ON harness_shared.work_items USING bm25 ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS work_items_bm25 ON harness_shared.work_items USING bm25 ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation harness_plans_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_plans_bm25 ON harness_shared.harness_plans USING bm25 ((coalesce(title, '') || ' ' || coalesce(content, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_plans_bm25 ON harness_shared.harness_plans USING bm25 ((coalesce(title, '') || ' ' || coalesce(content, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_plans_bm25 ON harness_shared.harness_plans USING bm25 ((coalesce(title, '') || ' ' || coalesce(content, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 1 documents, avg_length=3.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_plans_bm25 ON harness_shared.harness_plans USING bm25 ((coalesce(title, '') || ' ' || coalesce(content, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation goals_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS goals_bm25 ON harness_shared.goals USING bm25 ((coalesce(title, '') || ' ' || coalesce(body, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS goals_bm25 ON harness_shared.goals USING bm25 ((coalesce(title, '') || ' ' || coalesce(body, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS goals_bm25 ON harness_shared.goals USING bm25 ((coalesce(title, '') || ' ' || coalesce(body, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS goals_bm25 ON harness_shared.goals USING bm25 ((coalesce(title, '') || ' ' || coalesce(body, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation report_library_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS report_library_bm25 ON harness_shared.report_library USING bm25 ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(subject_label, '') || ' ' || left(coalesce(body_md, ''), 200000))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS report_library_bm25 ON harness_shared.report_library USING bm25 ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(subject_label, '') || ' ' || left(coalesce(body_md, ''), 200000))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS report_library_bm25 ON harness_shared.report_library USING bm25 ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(subject_label, '') || ' ' || left(coalesce(body_md, ''), 200000))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS report_library_bm25 ON harness_shared.report_library USING bm25 ((coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(subject_label, '') || ' ' || left(coalesce(body_md, ''), 200000))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation session_turns_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS session_turns_bm25 ON harness_shared.session_turns USING bm25 ((left(coalesce(text, ''), 20000))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS session_turns_bm25 ON harness_shared.session_turns USING bm25 ((left(coalesce(text, ''), 20000))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS session_turns_bm25 ON harness_shared.session_turns USING bm25 ((left(coalesce(text, ''), 20000))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS session_turns_bm25 ON harness_shared.session_turns USING bm25 ((left(coalesce(text, ''), 20000))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation documents_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS documents_bm25 ON harness_shared.documents USING bm25 ((coalesce(title, '') || ' ' || coalesce(text, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS documents_bm25 ON harness_shared.documents USING bm25 ((coalesce(title, '') || ' ' || coalesce(text, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS documents_bm25 ON harness_shared.documents USING bm25 ((coalesce(title, '') || ' ' || coalesce(text, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS documents_bm25 ON harness_shared.documents USING bm25 ((coalesce(title, '') || ' ' || coalesce(text, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation coord_thread_posts_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS coord_thread_posts_bm25 ON harness_shared.coord_thread_posts USING bm25 ((coalesce(body, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS coord_thread_posts_bm25 ON harness_shared.coord_thread_posts USING bm25 ((coalesce(body, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS coord_thread_posts_bm25 ON harness_shared.coord_thread_posts USING bm25 ((coalesce(body, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS coord_thread_posts_bm25 ON harness_shared.coord_thread_posts USING bm25 ((coalesce(body, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation carry_notes_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS carry_notes_bm25 ON harness_shared.carry_notes USING bm25 ((coalesce(note, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS carry_notes_bm25 ON harness_shared.carry_notes USING bm25 ((coalesce(note, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS carry_notes_bm25 ON harness_shared.carry_notes USING bm25 ((coalesce(note, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS carry_notes_bm25 ON harness_shared.carry_notes USING bm25 ((coalesce(note, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation code_recipes_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS code_recipes_bm25 ON harness_shared.code_recipes USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS code_recipes_bm25 ON harness_shared.code_recipes USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS code_recipes_bm25 ON harness_shared.code_recipes USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 4 documents, avg_length=32.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS code_recipes_bm25 ON harness_shared.code_recipes USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation datatype_registry_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS datatype_registry_bm25 ON harness_shared.datatype_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS datatype_registry_bm25 ON harness_shared.datatype_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS datatype_registry_bm25 ON harness_shared.datatype_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 19 documents, avg_length=14.11',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS datatype_registry_bm25 ON harness_shared.datatype_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation event_key_registry_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS event_key_registry_bm25 ON harness_shared.event_key_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS event_key_registry_bm25 ON harness_shared.event_key_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS event_key_registry_bm25 ON harness_shared.event_key_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS event_key_registry_bm25 ON harness_shared.event_key_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation capability_class_registry_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS capability_class_registry_bm25 ON harness_shared.capability_class_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS capability_class_registry_bm25 ON harness_shared.capability_class_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS capability_class_registry_bm25 ON harness_shared.capability_class_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS capability_class_registry_bm25 ON harness_shared.capability_class_registry USING bm25 ((coalesce(title, '') || ' ' || coalesce(description, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation audit_log_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS audit_log_bm25 ON harness_shared.audit_log USING bm25 ((coalesce(subject, '') || ' ' || coalesce(action, '') || ' ' || coalesce(actor, ''))) WITH (text_config = 'simple', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: simple',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS audit_log_bm25 ON harness_shared.audit_log USING bm25 ((coalesce(subject, '') || ' ' || coalesce(action, '') || ' ' || coalesce(actor, ''))) WITH (text_config = 'simple', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS audit_log_bm25 ON harness_shared.audit_log USING bm25 ((coalesce(subject, '') || ' ' || coalesce(action, '') || ' ' || coalesce(actor, ''))) WITH (text_config = 'simple', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS audit_log_bm25 ON harness_shared.audit_log USING bm25 ((coalesce(subject, '') || ' ' || coalesce(action, '') || ' ' || coalesce(actor, ''))) WITH (text_config = 'simple', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation harness_escalations_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_escalations_bm25 ON harness_shared.harness_escalations USING bm25 ((coalesce(escalation, '') || ' ' || coalesce(supervisor_notes, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_escalations_bm25 ON harness_shared.harness_escalations USING bm25 ((coalesce(escalation, '') || ' ' || coalesce(supervisor_notes, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_escalations_bm25 ON harness_shared.harness_escalations USING bm25 ((coalesce(escalation, '') || ' ' || coalesce(supervisor_notes, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_escalations_bm25 ON harness_shared.harness_escalations USING bm25 ((coalesce(escalation, '') || ' ' || coalesce(supervisor_notes, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation harness_decisions_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_decisions_bm25 ON harness_shared.harness_decisions USING bm25 ((coalesce(verb, '') || ' ' || coalesce(args, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_decisions_bm25 ON harness_shared.harness_decisions USING bm25 ((coalesce(verb, '') || ' ' || coalesce(args, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_decisions_bm25 ON harness_shared.harness_decisions USING bm25 ((coalesce(verb, '') || ' ' || coalesce(args, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_decisions_bm25 ON harness_shared.harness_decisions USING bm25 ((coalesce(verb, '') || ' ' || coalesce(args, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build started for relation harness_brainstorm_bm25',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_brainstorm_bm25 ON harness_shared.harness_brainstorm USING bm25 ((coalesce(content, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1648',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using text search configuration: english',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_brainstorm_bm25 ON harness_shared.harness_brainstorm USING bm25 ((coalesce(content, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1672',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'Using index options: k1=1.20, b=0.75',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_brainstorm_bm25 ON harness_shared.harness_brainstorm USING bm25 ((coalesce(content, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '1675',
  routine: 'tp_build'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'BM25 index build completed: 0 documents, avg_length=0.00',
  where: `SQL statement "CREATE INDEX  IF NOT EXISTS harness_brainstorm_bm25 ON harness_shared.harness_brainstorm USING bm25 ((coalesce(content, ''))) WITH (text_config = 'english', compaction = 'manual')"\n` +
    'PL/pgSQL function harness_shared.bm25_ensure_indexes(bigint) line 67 at EXECUTE\n' +
    'PL/pgSQL function inline_code_block line 5 at FOR over SELECT rows',
  file: 'build.c',
  line: '143',
  routine: 'tp_build_progress_end'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: work_items_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: harness_plans_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: goals_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: report_library_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: session_turns_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: documents_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: coord_thread_posts_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: carry_notes_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: code_recipes_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: datatype_registry_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: event_key_registry_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: capability_class_registry_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: audit_log_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: harness_escalations_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: harness_decisions_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'bm25_ensure_indexes: harness_brainstorm_bm25 -> created',
  where: 'PL/pgSQL function inline_code_block line 6 at RAISE',
  file: 'pl_exec.c',
  line: '3923',
  routine: 'exec_stmt_raise'
}
[with-test-pg] pg apply 1448-test-runs-configuration-snapshot.sql
[with-test-pg] pg apply 1449-benchmark-run-result-grader-status-invalid.sql
[with-test-pg] pg apply 1450-backfill-duplicate-drop-terminal-completion-ref.sql
[with-test-pg] pg apply 1451-tutorial-voice-reservations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "tutorial_voice_service" for relation "papercusp_auth.tutorial_voice_reservations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "tutorial_voice_reservations_guard" for relation "papercusp_auth.tutorial_voice_reservations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1453-plan-blind-reviews.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "plan_blind_reviews_no_update" for relation "harness_shared.plan_blind_reviews" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1454-tool-invocation-friction-pending-index.sql
[with-test-pg] pg apply 1455-coord-event-log-expect-effect-index.sql
[with-test-pg] pg apply 1456-dao-hr-work-profiles.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "dao_hr_work_profiles_workspace_isolation" for relation "harness_shared.dao_hr_work_profiles" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1457-dao-hr-contract-templates.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "dao_hr_admins_workspace_isolation" for relation "harness_shared.dao_hr_admins" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS dao_hr_admins_workspace_isolation ON harness_shared.dao_hr_admins"\n' +
    'PL/pgSQL function inline_code_block line 7 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "dao_hr_issuing_entities_workspace_isolation" for relation "harness_shared.dao_hr_issuing_entities" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS dao_hr_issuing_entities_workspace_isolation ON harness_shared.dao_hr_issuing_entities"\n' +
    'PL/pgSQL function inline_code_block line 7 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "dao_hr_contract_templates_workspace_isolation" for relation "harness_shared.dao_hr_contract_templates" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS dao_hr_contract_templates_workspace_isolation ON harness_shared.dao_hr_contract_templates"\n' +
    'PL/pgSQL function inline_code_block line 7 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "dao_hr_contract_template_versions_workspace_isolation" for relation "harness_shared.dao_hr_contract_template_versions" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS dao_hr_contract_template_versions_workspace_isolation ON harness_shared.dao_hr_contract_template_versions"\n' +
    'PL/pgSQL function inline_code_block line 7 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "dao_hr_counsel_approvals_workspace_isolation" for relation "harness_shared.dao_hr_counsel_approvals" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS dao_hr_counsel_approvals_workspace_isolation ON harness_shared.dao_hr_counsel_approvals"\n' +
    'PL/pgSQL function inline_code_block line 7 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1458-fallback-observations.sql
[with-test-pg] pg apply 1460-dao-hr-equity-policy.sql
[with-test-pg] pg apply 1461-dao-hr-policy-audit-snapshots.sql
[with-test-pg] pg apply 1462-dao-hr-hiring.sql
[with-test-pg] pg apply 1463-dao-hr-contracts-esign.sql
[with-test-pg] pg apply 1464-dao-hr-onboarding-proof.sql
[with-test-pg] pg apply 1465-dao-hr-engagement-changes.sql
[with-test-pg] pg apply 1468-drop-chat-bug-intake.sql
[with-test-pg] pg apply 1469-text-chunks-surface-hnsw.sql
[with-test-pg] pg apply 1470-drop-unused-report-chunk-hnsw.sql
[with-test-pg] pg apply 1471-retrieval-search-correlation.sql
[with-test-pg] pg apply 1472-disk-consumer-census.sql
[with-test-pg] pg apply 1473-hosted-directory-binding-audit.sql
[with-test-pg] pg apply 1474-blocked-requires-named-blocker.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "work_item_blocked_names_blocker" for relation "harness_shared.work_items" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1475-work-items-external-blockers-partial-idx.sql
[with-test-pg] pg apply 1476-work-items-issue-created-at-idx.sql
[with-test-pg] pg apply 1477-blocked-reason-freshness-and-review-park.sql
[with-test-pg] pg apply 1478-test-case-runs.sql
[with-test-pg] pg apply 1479-coord-event-log-unanswered-directed-lookups.sql
[with-test-pg] pg apply 1480-plan-now-note.sql
[with-test-pg] pg apply 1481-plan-now-note-row-clock-mask.sql
[with-test-pg] pg apply 1482-consult-post-meta-stance.sql
[with-test-pg] pg apply 1483-consult-state-park-state.sql
[with-test-pg] pg apply 1484-consult-state-no-launchable-responder.sql
[with-test-pg] pg apply 1485-host-contention-samples.sql
[with-test-pg] pg apply 1486-agent-usage-samples-harness-cov-idx.sql
[with-test-pg] pg apply 1487-agent-activity-owner-recency-idx.sql
[with-test-pg] pg apply 1489-fallback-observations-samples.sql
[with-test-pg] pg apply 1490-plan-decisions-lower-execution-tokens-idx.sql
[with-test-pg] pg apply 1491-pipeline-events-post-verdict-deadline-kind.sql
[with-test-pg] pg apply 1492-deliberate-session-retirement.sql
[with-test-pg] pg apply 1493-session-brief-recovery-delivery.sql
[with-test-pg] pg apply 1494-spawn-account-route-evidence.sql
[with-test-pg] pg apply 1495-hosted-budget-allocations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_budget_allocations_service" for relation "papercusp_auth.hosted_budget_allocations" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS hosted_budget_allocations_service ON papercusp_auth.hosted_budget_allocations"\n' +
    'PL/pgSQL function inline_code_block line 10 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hosted_budget_allocations_revision_guard" for relation "papercusp_auth.hosted_budget_allocations" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS hosted_budget_allocations_revision_guard ON papercusp_auth.hosted_budget_allocations"\n' +
    'PL/pgSQL function inline_code_block line 12 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_budget_allocation_holds_service" for relation "papercusp_auth.hosted_budget_allocation_holds" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS hosted_budget_allocation_holds_service ON papercusp_auth.hosted_budget_allocation_holds"\n' +
    'PL/pgSQL function inline_code_block line 10 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hosted_budget_allocation_holds_revision_guard" for relation "papercusp_auth.hosted_budget_allocation_holds" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS hosted_budget_allocation_holds_revision_guard ON papercusp_auth.hosted_budget_allocation_holds"\n' +
    'PL/pgSQL function inline_code_block line 12 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_outcome_cost_records_service" for relation "papercusp_auth.hosted_outcome_cost_records" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS hosted_outcome_cost_records_service ON papercusp_auth.hosted_outcome_cost_records"\n' +
    'PL/pgSQL function inline_code_block line 10 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "hosted_outcome_cost_records_revision_guard" for relation "papercusp_auth.hosted_outcome_cost_records" does not exist, skipping',
  where: 'SQL statement "DROP TRIGGER IF EXISTS hosted_outcome_cost_records_revision_guard ON papercusp_auth.hosted_outcome_cost_records"\n' +
    'PL/pgSQL function inline_code_block line 12 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1496-hosted-directory-group-mappings.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "directory_group_role_mappings_service_select" for relation "papercusp_auth.directory_group_role_mappings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "directory_group_role_mappings_service_insert" for relation "papercusp_auth.directory_group_role_mappings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "directory_group_role_mappings_service_update" for relation "papercusp_auth.directory_group_role_mappings" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "directory_user_observations_service_select" for relation "papercusp_auth.directory_user_observations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "directory_user_observations_service_insert" for relation "papercusp_auth.directory_user_observations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "directory_user_observations_service_update" for relation "papercusp_auth.directory_user_observations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1497-governance-policy-layers.sql
[with-test-pg] pg apply 1498-governance-sensitive-actions.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "governance_delegations_revoke_only_trg" for relation "harness_shared.governance_delegations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "sensitive_action_approvals_guard_trg" for relation "harness_shared.sensitive_action_approvals" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "sensitive_action_requests_transition_guard_trg" for relation "harness_shared.sensitive_action_requests" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1499-siem-export-streams.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "siem_export_streams_forward_only_trg" for relation "harness_shared.siem_export_streams" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "siem_export_deliveries_append_only_trg" for relation "harness_shared.siem_export_deliveries" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1500-chat-rollup-queue-failure-state.sql
[with-test-pg] pg apply 1501-organization-key-custody.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "organization_key_custody_guard_trg" for relation "harness_shared.organization_key_custody" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "organization_data_keys_guard_trg" for relation "harness_shared.organization_data_keys" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1502-document-legal-hold.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "documents_enforce_legal_hold" for relation "harness_shared.documents" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1503-organization-document-sealing.sql
[with-test-pg] pg apply 1504-consult-answer-lineage-index.sql
[with-test-pg] pg apply 1505-work-items-feature-family-scope-idx.sql
[with-test-pg] pg apply 1506-work-items-cited-assumptions-gin.sql
[with-test-pg] pg apply 1507-spec-conformance-state.sql
[with-test-pg] pg apply 1508-chat-hold-no-duplicate-revision.sql
[with-test-pg] pg apply 1509-hosted-customer-data-workspace-export.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_customer_export_owner" for relation "harness_shared.customer_workspaces" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS hosted_customer_export_owner ON harness_shared.customer_workspaces"\n' +
    'PL/pgSQL function inline_code_block line 13 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_customer_export_owner" for relation "papercusp_auth.organization_audit_events" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS hosted_customer_export_owner ON papercusp_auth.organization_audit_events"\n' +
    'PL/pgSQL function inline_code_block line 13 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_customer_export_owner" for relation "papercusp_auth.legal_acceptances" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS hosted_customer_export_owner ON papercusp_auth.legal_acceptances"\n' +
    'PL/pgSQL function inline_code_block line 13 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_customer_export_owner" for relation "papercusp_auth.support_access_grants" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS hosted_customer_export_owner ON papercusp_auth.support_access_grants"\n' +
    'PL/pgSQL function inline_code_block line 13 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "hosted_customer_export_owner" for relation "papercusp_auth.hosted_user_preferences" does not exist, skipping',
  where: 'SQL statement "DROP POLICY IF EXISTS hosted_customer_export_owner ON papercusp_auth.hosted_user_preferences"\n' +
    'PL/pgSQL function inline_code_block line 13 at EXECUTE',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1510-gateway-request-outcomes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "gateway_request_outcomes_workspace_isolation" for relation "harness_shared.gateway_request_outcomes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1512-work-items-substring-trigram-indexes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42710',
  message: 'extension "pg_trgm" already exists, skipping',
  file: 'extension.c',
  line: '2120',
  routine: 'CreateExtension'
}
[with-test-pg] pg apply 1514-governed-memory-anchors-and-outcomes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "memory_session_surfaced_outcome_check" of relation "memory_session_surfaced" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1515-hosted-billing-api-recovery.sql
[with-test-pg] pg apply 1516-retire-facebook-personal-vault-poll.sql
[with-test-pg] pg apply 1517-facebook-provider-legacy-grants-reconnect.sql
[with-test-pg] pg apply 1518-work-item-change-kind-declarations.sql
[with-test-pg] pg apply 1519-code-intel-pushes.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "code_intel_pushes_workspace" for relation "harness_shared.code_intel_pushes" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1520-session-archive-cold-storage.sql
[with-test-pg] pg apply 1521-locally-authored-rules.sql
[with-test-pg] pg apply 1522-workspace-host-pool-admission.sql
[with-test-pg] pg apply 1523-workspace-host-resource-incarnation.sql
[with-test-pg] pg apply 1524-hosted-entitlement-authority.sql
[with-test-pg] pg apply 1525-fallback-population-known.sql
[with-test-pg] pg apply 1527-rubric-amend-receipt-executor-identity.sql
[with-test-pg] pg apply 1529-session-list-historical-census-bounds.sql
[with-test-pg] pg apply 1530-test-downgrades.sql
[with-test-pg] pg apply 1531-doc-sections-lexical-index.sql
[with-test-pg] pg apply 1532-test-downgrades-kind.sql
[with-test-pg] pg apply 1533-gateway-response-usage-attribution.sql
[with-test-pg] pg apply 1534-work-items-duplicate-of.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "work_items_duplicate_detail_check" of relation "work_items" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "work_items_duplicate_source_check" of relation "work_items" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "work_items_duplicate_of_not_self" of relation "work_items" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1535-bug-inflow-daily.sql
[with-test-pg] pg apply 1536-plan-verification-profile-columns.sql
[with-test-pg] pg apply 1537-plan-verification-profile-row-clock-mask.sql
[with-test-pg] pg apply 1538-ledger-anchor-publication-intents.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "ledger_anchor_publications_workspace_isolation" for relation "harness_shared.ledger_anchor_publications" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1539-work-items-wait-ref-indexes.sql
[with-test-pg] pg apply 1540-git-sync-commit-attribution-repo-committed-at.sql
[with-test-pg] pg apply 1541-plan-type-registry.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_item_type_definitions_workspace_isolation" for relation "harness_shared.plan_item_type_definitions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_type_definitions_workspace_isolation" for relation "harness_shared.plan_type_definitions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1542-plan-item-deliverable-namespaced-slugs.sql
[with-test-pg] pg apply 1543-work-items-dependency-ref-ids-idx.sql
[with-test-pg] pg apply 1544-code-intel-push-skips.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "code_intel_push_skips_workspace" for relation "harness_shared.code_intel_push_skips" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1545-plan-type-pins.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_type_pins_workspace_isolation" for relation "harness_shared.plan_type_pins" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "plan_item_type_definitions_revision_immutable" for relation "harness_shared.plan_item_type_definitions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "plan_type_definitions_revision_immutable" for relation "harness_shared.plan_type_definitions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1546-event-awaits-change-notify.sql
[with-test-pg] pg apply 1547-type-pack-installations.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "type_pack_installations_workspace_isolation" for relation "harness_shared.type_pack_installations" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1548-plan-type-registry-change-notify.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.plan_item_type_definitions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.plan_type_definitions" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.plan_type_pins" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'trigger "emit_change_notify_trg" for relation "harness_shared.datatype_registry" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1549-plan-audits-change-notify.sql
[with-test-pg] pg apply 1551-cache-tag-mapped-table-producers.sql
[with-test-pg] pg apply 1552-test-executed-sources-recorded-git-dir.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'constraint "test_executed_sources_proof_key" of relation "test_executed_sources" does not exist, skipping',
  file: 'tablecmds.c',
  line: '14064',
  routine: 'ATExecDropConstraint'
}
[with-test-pg] pg apply 1554-gateway-request-outcome-attempt-account-ids.sql
[with-test-pg] pg apply 1555-work-item-duplicate-verdict-federation.sql
[with-test-pg] pg apply 1556-source-plan-route-claim-floor.sql
[with-test-pg] pg apply 1558-test-runs-file-path-substring-trigram-index.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42710',
  message: 'extension "pg_trgm" already exists, skipping',
  file: 'extension.c',
  line: '2120',
  routine: 'CreateExtension'
}
[with-test-pg] pg apply 1559-plan-item-code-anchors.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_item_anchors_workspace" for relation "harness_shared.plan_item_anchors" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "plan_anchor_notices_workspace" for relation "harness_shared.plan_anchor_notices" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1560-plan-blind-review-resume-bindings.sql
[with-test-pg] pg apply 1561-code-intel-research-trail.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "code_intel_research_trails_workspace" for relation "harness_shared.code_intel_research_trails" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1562-tool-invocations-campaign-owner-cover.sql
[with-test-pg] pg apply 1563-fleet-claim-history-owner-gin-index.sql
[with-test-pg] pg apply 1564-blind-review-outcomes.sql
[with-test-pg] pg apply 1565-routine-fire-committed-start-counters.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'policy "routine_fire_start_counts_workspace" for relation "harness_shared.routine_fire_start_counts" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '00000',
  message: 'event trigger "routine_fire_counter_dbos_create" does not exist, skipping',
  file: 'dropcmds.c',
  line: '521',
  routine: 'does_not_exist_skipping'
}
[with-test-pg] pg apply 1566-test-coverage-map.sql
[with-test-pg] pg apply 1567-blind-review-replacement-attempts.sql
[with-test-pg] pg apply 1568-semantic-code-index.sql
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42710',
  message: 'extension "vector" already exists, skipping',
  file: 'extension.c',
  line: '2120',
  routine: 'CreateExtension'
}
[with-test-pg] pg apply 1569-operator-chat-durable-state.sql
[with-test-pg] pg apply 1570-test-executed-sources-runtime-key.sql
[with-test-pg] pg apply 1574-operator-conversation-context-checkpoint.sql
[with-test-pg] pg apply 1575-preserve-frozen-test-calibration.sql
[with-test-pg] pg apply 1576-code-run-rollup-time-index.sql
[with-test-pg] pg apply 1577-sql-intent-candidate-history.sql
[with-test-pg] pg apply 1579-sql-candidate-review-lifecycle.sql
[with-test-pg] pg migrations: 1354 applied this boot (1354 total known)
[with-test-pg] ready — postgresql://harness_admin:***@localhost:33803/papercusp

> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts

[pc-heavy] release gate is JUDGING (phase=materializing) — heavy slots clamped to 1 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).
[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 3328904, waiting up to 30s
[pc-heavy] still queued (15s elapsed, pid 3328904, slots=1)
[pc-heavy] still queued (30s elapsed, pid 3328904, slots=1)
[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
Focused runner has no explicit PAPERCUSP_TEST_RUN_HARNESS. Test-ledger scope is unverified here; check the authoritative testing:runs row before binding proof, or set PAPERCUSP_TEST_RUN_HARNESS to the target harness (papercusp for this repo).
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=9 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=3372 capturedBytes=774 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/agent-tools/personal/search-freshness.integration.test.ts"}
PC_HEAVY_PREEMPT_READY pid=3358017
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=9 capturedBytes=0 completedFiles=[] pendingFiles=["lib/agent-tools/personal/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
[with-test-pg] pg pg: 2026-10-25 15:06:47.467 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.469 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.477 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.477 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.478 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.484 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.485 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.492 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.493 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.494 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.495 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.499 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.501 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.516 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.518 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.518 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.518 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.519 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.520 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.521 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.522 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.523 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.524 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.525 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.527 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.529 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.530 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.535 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.537 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.542 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.543 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.547 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.549 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.551 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.554 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.557 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.558 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.561 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.562 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.569 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.570 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.572 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.573 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.584 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.585 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.594 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.595 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.597 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.599 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.602 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.608 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.610 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.611 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.612 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.613 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.615 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.616 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.618 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.620 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.624 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.629 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.634 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.635 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.637 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.647 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.652 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.653 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.656 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.658 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.660 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.661 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.663 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.664 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.666 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.670 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.671 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.678 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.683 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.716 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.725 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.748 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.752 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.756 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.759 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.777 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.782 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.785 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.795 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.843 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.846 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.848 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.855 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.891 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.897 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.898 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.902 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.904 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.905 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.914 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.917 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.918 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:47.922 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.560 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.565 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.566 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.567 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.580 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.581 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.583 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.584 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.585 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.587 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.592 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.595 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.620 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.625 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.652 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.654 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.680 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.681 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.788 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.796 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.798 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.799 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.837 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.840 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.869 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.882 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.885 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.889 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.891 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:48.892 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.134 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.138 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.139 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.141 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.149 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.152 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.153 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.153 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.154 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.156 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.157 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.157 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.159 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.164 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.166 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.170 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.172 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.172 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.256 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.258 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.261 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.268 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.270 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.276 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.277 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.281 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.283 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.288 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.290 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.293 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.295 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.299 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.310 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.313 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.314 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.317 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.321 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.325 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.330 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.331 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.333 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.334 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.339 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.340 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.347 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.353 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.370 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.371 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.373 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.375 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.383 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:49.387 EDT [3371109] WARNING:  there is no transaction in progress

TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10010 capturedBytes=800 completedFiles=[] pendingFiles=["lib/agent-tools/personal/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core"}
[with-test-pg] pg pg: 2026-10-25 15:06:52.076 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:52.080 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:52.230 EDT [3371109] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:52.231 EDT [3371109] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.947 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.948 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.954 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.954 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.955 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.963 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.964 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.969 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.969 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.969 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.970 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.977 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.978 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.993 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.993 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.994 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.994 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.995 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.995 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.996 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.997 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.999 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:57.999 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.000 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.000 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.002 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.003 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.008 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.009 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.013 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.014 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.016 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.017 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.020 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.022 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.025 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.026 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.028 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.029 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.035 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.036 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.038 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.038 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.046 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.047 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.050 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.050 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.052 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.052 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.055 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.056 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.057 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.058 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.058 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.058 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.061 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.061 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.063 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.063 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.066 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.067 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.070 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.070 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.072 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.076 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.080 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.081 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.083 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.083 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.085 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.085 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.087 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.088 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.090 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.090 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.091 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.093 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.097 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.114 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.119 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.129 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.131 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.134 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.137 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.143 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.146 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.146 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.156 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.187 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.189 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.190 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.193 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.214 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.217 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.217 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.220 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.220 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.221 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.226 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.227 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.228 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.230 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.487 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.490 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.491 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.492 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.499 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.499 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.500 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.500 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.501 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.503 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.506 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.508 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.521 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.523 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.539 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.541 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.559 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.560 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.614 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.623 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.624 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.625 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.646 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.649 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.658 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.669 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.670 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.675 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.676 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.677 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.810 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.812 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.813 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.814 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.815 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.816 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.817 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.817 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.818 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.819 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.820 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.820 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.821 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.823 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.824 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.827 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.827 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.828 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.874 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.876 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.876 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.880 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.881 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.885 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.886 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.888 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.889 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.893 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.894 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.897 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.898 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.903 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.909 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.912 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.913 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.914 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.916 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.919 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.920 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.921 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.922 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.922 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.924 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.924 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.927 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.931 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.935 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.936 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.936 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.938 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.941 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:06:58.945 EDT [3380214] WARNING:  there is no transaction in progress

TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20011 capturedBytes=964 completedFiles=[] pendingFiles=["lib/agent-tools/personal/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"[baseline-schema-global-setup] stage=migration-apply status=done elapsedMs=9420"}
[with-test-pg] pg pg: 2026-10-25 15:07:01.225 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:07:01.228 EDT [3380214] WARNING:  there is no transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:07:01.370 EDT [3380214] WARNING:  there is already a transaction in progress

[with-test-pg] pg pg: 2026-10-25 15:07:01.370 EDT [3380214] WARNING:  there is no transaction in progress

TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30012 capturedBytes=1804 completedFiles=[] pendingFiles=["lib/agent-tools/personal/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3365988,\"event\":\"started-received\",\"childPid\":3388501,\"elapsedMs\":430,\"startupMs\":429,\"error\":false}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=40013 capturedBytes=1804 completedFiles=[] pendingFiles=["lib/agent-tools/personal/search-freshness.integration.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":3365988,\"event\":\"started-received\",\"childPid\":3388501,\"elapsedMs\":430,\"startupMs\":429,\"error\":false}"}
[with-test-pg] pg pg: 2026-10-25 15:07:23.808 EDT [3318916] LOG:  checkpoint starting: immediate force wait

TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > social:search labels and ledgers restricted results, constraining subsequent egress","state":"failed","errors":[{"message":"expected undefined to deeply equal { level: 'participants', …(1) }","stack":"AssertionError: expected undefined to deeply equal { level: 'participants', …(1) }\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts:192:32\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"}]}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > withholds restricted social hits from an unattributed caller","state":"failed","errors":[{"message":"expected [ { …(9) } ] to deeply equal []","stack":"AssertionError: expected [ { …(9) } ] to deeply equal []\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts:205:29\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"}]}
[with-test-pg] pg pg: 2026-10-25 15:07:24.029 EDT [3318916] LOG:  checkpoint complete: wrote 9937 buffers (60.7%), wrote 6 SLRU buffers; 0 WAL file(s) added, 0 removed, 12 recycled; write=0.138 s, sync=0.005 s, total=0.221 s; sync files=0, longest=0.000 s, average=0.000 s; distance=193170 kB, estimate=193170 kB; lsn=0/D3F4418, redo lsn=0/D3F43C0

PC_HEAVY_PSI_FINALIZATION pid=3358017
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=44262 capturedBytes=7070 completedFiles=["lib/agent-tools/personal/search-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"❯ lib/agent-tools/personal/search-freshness.integration.test.ts (6 tests | 2 failed) 3420ms"}
[with-test-pg] pg pg: 2026-10-25 15:07:28.367 EDT [3318916] LOG:  checkpoint starting: immediate force wait

[with-test-pg] pg pg: 2026-10-25 15:07:28.370 EDT [3318916] LOG:  checkpoint complete: wrote 43 buffers (0.3%), wrote 1 SLRU buffers; 0 WAL file(s) added, 0 removed, 0 recycled; write=0.002 s, sync=0.001 s, total=0.003 s; sync files=0, longest=0.000 s, average=0.000 s; distance=382 kB, estimate=173891 kB; lsn=0/D453DF0, redo lsn=0/D453D98

TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=49772 capturedBytes=11441 completedFiles=["lib/agent-tools/personal/search-freshness.integration.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-Zum5bu/group-0.json"}
Running as unit: papercusp-test-3358017-mvo78edx-4.scope; invocation ID: bc8d579d6c2e4e72a6313f5f9b172093
TEST_FILE_STARTUP_TRACE {"pid":3364653,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
[baseline-schema-global-setup] stage=migration-apply status=waiting elapsedMs>=5000
[baseline-schema-global-setup] stage=migration-apply status=done elapsedMs=9420
[getOrBuildTemplate] stage=template-build key=e16fd6df1d391c96 migrations=1354 elapsedMs=8051
[org-template-global-setup] template ready key=e16fd6df1d391c96 name=tmpl_e16fd6df1d391c96 elapsedMs=8161
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"worker-forked","childPid":3388501}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"start-sent","childPid":3388501,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":3388501,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"started-received","childPid":3388501,"elapsedMs":430,"startupMs":429,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > compares all eight fields and excludes foreign users, mail from social, and ungranted sources"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > compares all eight fields and excludes foreign users, mail from social, and ungranted sources","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > observes in-place updates and candidate insertion/removal through both entrypoints"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > observes in-place updates and candidate insertion/removal through both entrypoints","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > refuses both entrypoints after grant revocation"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > refuses both entrypoints after grant revocation","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > personal:search labels and ledgers restricted results, constraining subsequent egress"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > personal:search labels and ledgers restricted results, constraining subsequent egress","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > social:search labels and ledgers restricted results, constraining subsequent egress"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > social:search labels and ledgers restricted results, constraining subsequent egress","state":"failed","errors":[{"message":"expected undefined to deeply equal { level: 'participants', …(1) }","stack":"AssertionError: expected undefined to deeply equal { level: 'participants', …(1) }\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts:192:32\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"}]}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > withholds restricted social hits from an unattributed caller"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts","name":"P001 personal:search and social:search dispatch witnesses > withholds restricted social hits from an unattributed caller","state":"failed","errors":[{"message":"expected [ { …(9) } ] to deeply equal []","stack":"AssertionError: expected [ { …(9) } ] to deeply equal []\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts:205:29\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"}]}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"stop-sent","childPid":3388501,"elapsedMs":19749}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"stopped-received","childPid":3388501,"elapsedMs":19750,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"worker-signal","childPid":3388501,"elapsedMs":19751,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"worker-disconnect","childPid":3388501,"elapsedMs":19854}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"worker-exit","childPid":3388501,"elapsedMs":19855,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":3365988,"event":"worker-close","childPid":3388501,"elapsedMs":19855,"code":null,"signal":"SIGTERM"}

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  lib/agent-tools/personal/search-freshness.integration.test.ts > P001 personal:search and social:search dispatch witnesses > social:search labels and ledgers restricted results, constraining subsequent egress
AssertionError: expected undefined to deeply equal { level: 'participants', …(1) }

- Expected:
{
  "level": "participants",
  "readerSet": [
    "alice@example.test",
  ],
}

+ Received:
undefined

 ❯ lib/agent-tools/personal/search-freshness.integration.test.ts:192:32
    190|       const rows = r.response.results ?? r.response.hits ?? [];
    191|       expect(rows).toHaveLength(1);
    192|       expect(rows[0]!.privacy).toEqual({ level: 'participants', reader…
       |                                ^
    193|       expect(r.response.restrictedResults).toBe(1);
    194|       const ledger = await org.adminSql`SELECT agent_owner_id,delivere…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  lib/agent-tools/personal/search-freshness.integration.test.ts > P001 personal:search and social:search dispatch witnesses > withholds restricted social hits from an unattributed caller
AssertionError: expected [ { …(9) } ] to deeply equal []

- Expected
+ Received

- []
+ [
+   {
+     "author": "alice@example.test",
+     "occurredAt": "2026-10-01 08:00:00-04",
+     "platform": "bluesky",
+     "platformLabel": "bluesky",
+     "postId": "bluesky:at://did:plc:p001/app.bsky.feed.post/cobalt",
+     "replyable": {
+       "allowed": true,
+     },
+     "score": 0.01639344262295082,
+     "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
+     "title": "Cobalt bluesky version 1",
+   },
+ ]

 ❯ lib/agent-tools/personal/search-freshness.integration.test.ts:205:29
    203|       level: 'participants', actor: 'fixture-owner', authorityRef: nul…
    204|     const r = await call('social:search', null);
    205|     expect(r.response.hits).toEqual([]);
       |                             ^
    206|     expect(r.response.withheldRestricted).toBe(1);
    207|     expect(await org.adminSql`SELECT id FROM harness_shared.personal_d…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

TEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed
TEST_FILE_ASSERTION_FAILURE file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts" name="P001 personal:search and social:search dispatch witnesses social:search labels and ledgers restricted results, constraining subsequent egress" message="AssertionError: expected undefined to deeply equal { level: 'participants', …(1) }\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts:192:32\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"
TEST_FILE_ASSERTION_FAILURE file="/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts" name="P001 personal:search and social:search dispatch witnesses withholds restricted social hits from an unattributed caller" message="AssertionError: expected [ { …(9) } ] to deeply equal []\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts:205:29\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20"
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-3328904-1792955191646259084 retryHandle=psi-recovery:pc-heavy-3328904-1792955191646259084 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=f9439c620f testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-25T19:06:35.420Z
  HEAD         : f9439c620f
  tested files : packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts
ROUTE cwd=packages/operator-core config=vitest.integration.config.ts
  requested lib/agent-tools/personal/search-freshness.integration.test.ts
  matched lib/agent-tools/personal/search-freshness.integration.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ❯ lib/agent-tools/personal/search-freshness.integration.test.ts (6 tests | 2 failed) 3420ms
     ✓ compares all eight fields and excludes foreign users, mail from social, and ungranted sources  1435ms
     ✓ observes in-place updates and candidate insertion/removal through both entrypoints 102ms
     ✓ refuses both entrypoints after grant revocation 32ms
     ✓ personal:search labels and ledgers restricted results, constraining subsequent egress 33ms
     × social:search labels and ledgers restricted results, constraining subsequent egress 37ms
     × withholds restricted social hits from an unattributed caller 46ms

 Test Files  1 failed (1)
      Tests  2 failed | 4 passed (6)
   Start at  15:06:44
   Duration  40.31s (transform 11.36s, setup 425ms, import 15.45s, tests 3.42s, environment 0ms)

TEST_FILE_PROVENANCE head=f9439c620f testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-25T19:07:29.855Z
  HEAD         : f9439c620f
  tested files : packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts  [UNTRACKED — exists only on this box]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/agent-tools/personal/search-freshness.integration.test.ts
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=f9439c620f uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-25T19:06:35.420Z childSubstituted=0 skippedTests=0
[with-test-pg] pg stopping postgres
[with-test-pg] pg pg: 2026-10-25 15:07:30.039 EDT [3318895] LOG:  received fast shutdown request
2026-10-25 15:07:30.039 EDT [3318895] LOG:  aborting any active transactions

[with-test-pg] pg pg: 2026-10-25 15:07:30.041 EDT [3318895] LOG:  background worker "logical replication launcher" (PID 3318923) exited with exit code 1

[with-test-pg] pg pg: 2026-10-25 15:07:30.045 EDT [3318916] LOG:  shutting down

[with-test-pg] pg pg: 2026-10-25 15:07:30.045 EDT [3318916] LOG:  checkpoint starting: shutdown immediate

[with-test-pg] pg pg: 2026-10-25 15:07:30.046 EDT [3318916] LOG:  checkpoint complete: wrote 1 buffers (0.0%), wrote 1 SLRU buffers; 0 WAL file(s) added, 0 removed, 0 recycled; write=0.001 s, sync=0.001 s, total=0.001 s; sync files=0, longest=0.000 s, average=0.000 s; distance=0 kB, estimate=156502 kB; lsn=0/D453F88, redo lsn=0/D453F88

[with-test-pg] pg pg: 2026-10-25 15:07:30.107 EDT [3318895] LOG:  database system is shut down



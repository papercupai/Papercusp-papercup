---
rel_path: "runtime-migration/p001-tick-descendant-fencing-ledger-501c.json"
updated_at: 1792759321870
_body: "content"
---

{
  "schema": "papercusp-tick-descendant-fencing-source-ledger-v1",
  "workItem": "WI-6554700010022067",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "planItem": "P-001",
  "sourceOnly": true,
  "closureAccepted": false,
  "observedAt": "2026-10-23T10:32:56.139397+00:00",
  "parentArtifact": "runtime-migration/p001-tick-immediate-descendants-501c.json",
  "populationWriter": "buildDefaultChecks",
  "rows": [
    {
      "id": "dbos-history-ceiling",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "system-health",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "harness-status-sweep",
      "scope": "host-default",
      "descendantCoverage": "partial",
      "classification": "row-predicate-with-suspected-generation-race",
      "evidence": "harness-status-sweep.ts:96-170",
      "protection": "agent_runs update predicates running=true and updated_ts<cutoff. Lane delete predicates only slug/phase/role after asynchronous PID snapshot.",
      "persistedState": "Per-harness agent_runs and org harness_lanes",
      "residue": "EI-26765683254627257"
    },
    {
      "id": "connection-pressure",
      "scope": "process",
      "descendantCoverage": "partial",
      "classification": "process-local-adaptive-state",
      "evidence": "in-process-periodic.ts:234-273",
      "protection": "Declared process scope; observes shared PG pressure into this process's connectionPressureGovernor. No cross-process fence is implied.",
      "persistedState": "Not in the observed governor update; pgHealth reads shared server state."
    },
    {
      "id": "pg-tuning-drift",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "kernel-leak-watchdog",
      "scope": "host-default",
      "descendantCoverage": "partial",
      "classification": "sample-write-uniqueness-only",
      "evidence": "kernel-leak-watchdog.ts:418-439",
      "protection": "Sample writer ON CONFLICT (boot_id,bucket_at) DO NOTHING. Alarm descendants remain untraced.",
      "persistedState": "harness_shared.host_kernel_memory_samples"
    },
    {
      "id": "host-contention-sampler",
      "scope": "host-default",
      "descendantCoverage": "partial",
      "classification": "sample-write-uniqueness-only",
      "evidence": "kernel-leak-watchdog.ts:418-439",
      "protection": "Shares sample writer ON CONFLICT (boot_id,bucket_at) DO NOTHING. This limits sample rows, not process ownership.",
      "persistedState": "harness_shared.host_kernel_memory_samples"
    },
    {
      "id": "service-health",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "completion-ref-verify",
      "scope": "host-default",
      "descendantCoverage": "partial",
      "classification": "observed-reference-CAS-with-regression",
      "protection": "UPDATE matches observed completion_ref JSONB and RETURNING; both callers discard stale outcome effects.",
      "evidence": "runtime-migration/p001-completion-ref-redgreen-501c.json",
      "persistedState": "Feature verification timestamps/errors; backoff remains process-local.",
      "residue": "Backoff/toast/notification descendants and immutable-candidate/global-owner acceptance remain on P001."
    },
    {
      "id": "spawn-reclaim-sweep",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "stale-claim-sweep",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "release-request-sweep",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "learning-infra-health",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "steering-churn-sweep",
      "scope": "host-default",
      "descendantCoverage": "partial",
      "classification": "atomic-cooldown-claim-before-advisory",
      "evidence": "steering-churn.ts:220-246,308-318",
      "protection": "ON CONFLICT workspace_id/harness_slug/feature_id updates only when prior last_escalated_ts<=cutoff, RETURNING gates advisory. This is cooldown admission, not a global timer lease or atomic advisory delivery.",
      "persistedState": "harness_shared.steering_churn_escalations; pruning steering_churn_events by cutoff"
    },
    {
      "id": "federation-drain-reconcile",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "pot-epoch-key-reconcile",
      "scope": "host-default",
      "descendantCoverage": "partial",
      "classification": "keychain-write-and-federation-source-path-traced",
      "evidence": "runtime-migration/p001-shared-effect-sinks-501c.json",
      "protection": "Flag/author gate; revoked snapshot; row uniqueness/LWW; keychain read-error guard. No exclusive process-owner proof.",
      "persistedState": "OS keychain/encrypted file mirrors, pot_epoch_keys, SQL HLC/outbox and native own log.",
      "residue": "Further global-owner/platform/candidate and complete remaining leaves stay on P001."
    },
    {
      "id": "shared-presence-reaper",
      "scope": "host-default",
      "descendantCoverage": "partial",
      "classification": "SQL-predicate-retention",
      "evidence": "shared-presence-reaper.ts:48-111",
      "protection": "TTL deletes repeat their stale timestamp predicate in SQL; per-device caps rank by workspace/device and delete matching ctid overflow. No global lease claimed.",
      "persistedState": "harness_shared.shared_presence and shared_session_presence"
    },
    {
      "id": "scorecard-emission-pulse",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "poll-suspect-scan",
      "scope": "host-default",
      "descendantCoverage": "untraced"
    },
    {
      "id": "timer-registration-scan",
      "scope": "host-default",
      "descendantCoverage": "partial",
      "classification": "known-name-insert-uniqueness-only",
      "evidence": "poll-suspect-alarm.ts:290-306",
      "protection": "Known-timer persistence INSERT ON CONFLICT(name) DO NOTHING. Scan/diff/notification descendants remain untraced.",
      "persistedState": "harness_shared.known_timer_registrations"
    }
  ],
  "sourceHashes": {
    "packages/operator-core/lib/harness-status-sweep.ts": "07add91207d60ec7c01e07e7f70c7cf274efb14325dd770be2749c63052912b6",
    "packages/operator-core/lib/steering-churn.ts": "a6435c863a4d741168fdd63c443d49cd3d110e9db73ed22c23256d0f27d82276",
    "packages/operator-core/lib/sync/hyperbee/shared-presence-reaper.ts": "b082efdc48ae03d6856e78ac1d780a2e4202363fa9e7d2ddec857eb9cb937347",
    "packages/operator-core/lib/system-health/kernel-leak-watchdog.ts": "b7a3a054f3c17411ef5c661fd7768654f739e50667f778f76495652d5db7fd16",
    "packages/operator-core/lib/poll-suspect-alarm.ts": "b515c8e3b05e701fb646a007a94428feb1ebcc8adee97048234fefaad7270e29",
    "packages/operator-core/lib/dbos/in-process-periodic.ts": "1cb972f5dcb0cd39d5bc0d9f03b602f05acdd4a501d78243cfd883b36bb933bc"
  },
  "evidence": [
    {
      "path": "packages/operator-core/lib/harness-status-sweep.ts",
      "start": 96,
      "end": 170,
      "source": "async function sweepAgentRunsRunning(): Promise<void> {\n  const reg = await loadHarnessRegistry();\n  const projects = reg.projects ?? [];\n  const cutoff = Date.now() - LANE_STALE_MS;\n  for (const proj of projects) {\n    try {\n      // Per-harness schema reach via search_path. Use postgres-js raw exec\n      // on the org pool with set_config for the search path.\n      const { sql } = getOrgPg();\n      const schema = schemaIdentForSlug(proj.slug);\n      // Skip if the schema doesn't exist yet (uninstalled harness).\n      const exists = await sql<{ exists: boolean }[]>`\n        SELECT EXISTS (\n          SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}\n        ) AS exists\n      `;\n      if (!exists[0]?.exists) continue;\n      // Identifier is sanitized above; the cutoff travels as a bound\n      // parameter, not string interpolation (audit P-029).\n      await sql.unsafe(\n        `UPDATE ${schema}.agent_runs SET running = false\n          WHERE running = true AND updated_ts < $1`,\n        [cutoff],\n      );\n    } catch (e) {\n      console.warn(`[harness-status-sweep] agent_runs sweep failed for ${proj.slug}:`, (e as Error)?.message ?? e);\n    }\n  }\n}\n\nasync function sweepHarnessLanes(): Promise<void> {\n  const { sql } = getOrgPg();\n  const cutoff = Date.now() - LANE_STALE_MS;\n  // Drop lanes where:\n  //   - the recorded PID is gone (definitive — caller died)\n  //   - OR started_at is older than LANE_STALE_MS (no PID recorded; conservative)\n  //\n  // Two-step: read lanes, decide which to drop, then DELETE the survivors.\n  // Doing the PID check inline in SQL is impossible; we have to read.\n  try {\n    const { db } = getOrgPg();\n    const rows = await db\n      .select({\n        harness_slug: hl.harnessSlug,\n        phase: hl.phase,\n        role: hl.role,\n        pid: hl.pid,\n        started_at: hl.startedAt,\n      })\n      .from(hl);\n    for (const r of rows) {\n      const startedAt = Number(r.started_at);\n      const pidPresent = r.pid != null;\n      const pidGone = pidPresent && !pidIsAlive(Number(r.pid));\n      // PID-based liveness wins when we have it. Age-based sweep only\n      // applies as a fallback when the row has no PID (legacy schema or\n      // pg_write_lane fired before the worker pid was captured).\n      const ageStale = !pidPresent\n        && (!Number.isFinite(startedAt) || startedAt < cutoff);\n      if (!pidGone && !ageStale) continue;\n      await db\n        .delete(hl)\n        .where(and(eq(hl.harnessSlug, r.harness_slug), eq(hl.phase, r.phase), eq(hl.role, r.role)));\n    }\n  } catch (e) {\n    console.warn('[harness-status-sweep] lane sweep failed:', (e as Error)?.message ?? e);\n  }\n}\n\n/**\n * One sweep pass — the in-process periodic scheduler and the legacy fallback\n * timer both call this. Iteration column is orchestrator-owned; the sweeper never\n * writes it. harness_status stalled detection moved to expirable-registry once\n * the schema grew an explicit expires_at column. This sweeper only handles\n * PID-liveness work that TTL can't model cleanly."
    },
    {
      "path": "packages/operator-core/lib/steering-churn.ts",
      "start": 220,
      "end": 246,
      "source": "  if (!result.trip) return { result, escalated: false };\n\n  // Debounce atomically: insert-or-update the per-item escalation marker only\n  // when the cooldown has elapsed. A DO-UPDATE that fails its WHERE returns no\n  // row → already alerted this cooldown → suppress.\n  const cutoff = now - cooldownMs;\n  const marker = await sql<{ last_escalated_ts: string | number }[]>`\n    INSERT INTO harness_shared.steering_churn_escalations\n      (workspace_id, harness_slug, feature_id, last_escalated_ts, churn_count)\n    VALUES (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.featureId}, ${now}, ${result.churnCount})\n    ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE\n      SET last_escalated_ts = EXCLUDED.last_escalated_ts,\n          churn_count = EXCLUDED.churn_count\n      WHERE steering_churn_escalations.last_escalated_ts <= ${cutoff}\n    RETURNING last_escalated_ts`;\n  if (marker.length === 0) return { result, escalated: false };\n\n  const escalate = opts.escalate ?? defaultSteeringChurnEscalator;\n  await escalate({\n    workspaceId: opts.workspaceId,\n    harnessSlug: opts.harnessSlug,\n    featureId: opts.featureId,\n    result,\n    windowMs,\n  });\n  return { result, escalated: true };\n}"
    },
    {
      "path": "packages/operator-core/lib/steering-churn.ts",
      "start": 308,
      "end": 318,
      "source": "export async function pruneSteeringChurnEvents(\n  opts: { now?: number; retentionMs?: number; sql?: Sql } = {},\n): Promise<number> {\n  const now = opts.now ?? Date.now();\n  const retentionMs = opts.retentionMs ?? STEERING_CHURN_RETENTION_MS;\n  const sql = opts.sql ?? getOrgPg().sql;\n  const cutoff = now - retentionMs;\n  const deleted = await sql`DELETE FROM harness_shared.steering_churn_events WHERE ts < ${cutoff}`;\n  return deleted.count ?? 0;\n}"
    },
    {
      "path": "packages/operator-core/lib/sync/hyperbee/shared-presence-reaper.ts",
      "start": 48,
      "end": 111,
      "source": "  sessionCapReaped: number;\n}\n\nexport interface ReapSharedPresenceOpts {\n  /** TTL for the staleness delete (ms). Omitted ⇒ coord-liveness-config override\n   *  or the baked 4h default. */\n  ttlMs?: number;\n  /** Max rows retained per (workspace, device_pubkey). Omitted ⇒ config override\n   *  or the baked 128 default. */\n  maxRowsPerDevice?: number;\n  /** Clock seam for the TTL floor (tests). */\n  nowMs?: number;\n  /** Test/multi-peer seam — reap on THIS client instead of the process-global. */\n  sql?: postgres.Sql;\n}\n\n/**\n * Reap both federated presence tables: TTL delete, then a per-(workspace,device)\n * cap. Reads its TTL + cap from coord-liveness-config when not overridden by opts\n * (the scheduled tick passes nothing). Returns the per-pass, per-table counts.\n */\nexport async function reapStaleSharedPresence(\n  opts: ReapSharedPresenceOpts = {},\n): Promise<SharedPresenceReapResult> {\n  const sql = opts.sql ?? getOrgPg().sql;\n  let ttlMs = opts.ttlMs;\n  let cap = opts.maxRowsPerDevice;\n  if (ttlMs == null || cap == null) {\n    const cfg = await readCoordLivenessConfig();\n    ttlMs ??= cfg.sharedPresenceReaperTtlMs ?? COORD_LIVENESS_DEFAULTS.sharedPresenceReaperTtlMs;\n    cap ??= cfg.sharedPresenceMaxRowsPerDevice ?? COORD_LIVENESS_DEFAULTS.sharedPresenceMaxRowsPerDevice;\n  }\n  // ISO string + explicit cast, NOT a Date object: the org PG client (`getOrgPg`)\n  // rejects a raw Date bind param (\"The string argument must be … Received an\n  // instance of Date\") — see the `org-pg-client-rejects-raw-date` memory / EI-2549.\n  const floorIso = new Date((opts.nowMs ?? Date.now()) - ttlMs).toISOString();\n\n  // 1. TTL — a row older than the reaper TTL is well past every reader's window.\n  const pTtl = await sql`\n    DELETE FROM harness_shared.shared_presence WHERE last_seen_at < ${floorIso}::timestamptz\n  `;\n  const sTtl = await sql`\n    DELETE FROM harness_shared.shared_session_presence WHERE last_seen_at < ${floorIso}::timestamptz\n  `;\n\n  // 2. Per-device cap — keep the `cap` most-recent rows per (workspace, device),\n  //    delete the overflow. ctid is the stable within-scan row id; the tiebreak on\n  //    ctid keeps the ranking deterministic when last_seen_at ties.\n  const pCap = await sql`\n    DELETE FROM harness_shared.shared_presence sp\n    USING (\n      SELECT ctid, row_number() OVER (\n        PARTITION BY workspace_id, device_pubkey\n        ORDER BY last_seen_at DESC, ctid DESC\n      ) AS rn\n      FROM harness_shared.shared_presence\n    ) ranked\n    WHERE sp.ctid = ranked.ctid AND ranked.rn > ${cap}\n  `;\n  const sCap = await sql`\n    DELETE FROM harness_shared.shared_session_presence ssp\n    USING (\n      SELECT ctid, row_number() OVER (\n        PARTITION BY workspace_id, device_pubkey"
    },
    {
      "path": "packages/operator-core/lib/system-health/kernel-leak-watchdog.ts",
      "start": 418,
      "end": 439,
      "source": "\n// NB: the org pool rejects Date params — timestamps go in as ISO strings (see\n// system-health/history.ts), and bigint columns come back as strings.\nasync function defaultStore(sample: KernelMemorySample, contention: HostContentionReading | null): Promise<void> {\n  const { sql } = getOrgPg();\n  const bucketMs = Math.floor(sample.sampledAtMs / KERNEL_LEAK_SAMPLE_INTERVAL_MS) * KERNEL_LEAK_SAMPLE_INTERVAL_MS;\n  const p = contention?.pressure ?? null;\n  const usage = contention?.cgroupCpuUsageUs ?? null;\n  await sql`\n    INSERT INTO harness_shared.host_kernel_memory_samples\n      (boot_id, bucket_at, sampled_at, host, booted_at, mem_total_bytes, sunreclaim_bytes, slab_bytes, dying_descendants,\n       cpu_some_stall_us, io_some_stall_us, io_full_stall_us, memory_some_stall_us, memory_full_stall_us,\n       cgroup_cpu_usage_us)\n    VALUES (${sample.bootId}, ${new Date(bucketMs).toISOString()}, ${new Date(sample.sampledAtMs).toISOString()},\n            ${sample.host}, ${new Date(sample.bootedAtMs).toISOString()}, ${sample.memTotalBytes},\n            ${sample.sUnreclaimBytes}, ${sample.slabBytes}, ${sample.dyingDescendants},\n            ${p?.cpuSomeUs ?? null}, ${p?.ioSomeUs ?? null}, ${p?.ioFullUs ?? null},\n            ${p?.memorySomeUs ?? null}, ${p?.memoryFullUs ?? null},\n            ${usage === null ? null : JSON.stringify(usage)}::jsonb)\n    ON CONFLICT (boot_id, bucket_at) DO NOTHING`;\n}\n"
    },
    {
      "path": "packages/operator-core/lib/poll-suspect-alarm.ts",
      "start": 290,
      "end": 306,
      "source": "\nasync function defaultPersistKnownNames(rows: TimerRegistration[]): Promise<void> {\n  if (rows.length === 0) return;\n  const { getOrgPg } = await import('@papercusp/db-org');\n  const { sql } = getOrgPg();\n  // Row-at-a-time ON CONFLICT DO NOTHING — this table only ever gains a handful of\n  // rows per scan (a brand-new timer name is rare by construction), so a bulk\n  // multi-row VALUES clause would be premature complexity here.\n  for (const r of rows) {\n    await sql`\n      INSERT INTO harness_shared.known_timer_registrations (name, source)\n      VALUES (${r.name}, ${r.source})\n      ON CONFLICT (name) DO NOTHING`;\n  }\n}\n\n/**"
    },
    {
      "path": "packages/operator-core/lib/dbos/in-process-periodic.ts",
      "start": 234,
      "end": 273,
      "source": "const connectionPressureCheck: PeriodicCheck = {\n  name: 'connection-pressure',\n  intervalMs: 30_000,\n  // D-004 (P-011): live server-wide PG connection saturation has no change-event source.\n  classification: 'must-sample',\n  // P-018: the ONE check that stays per-process. The READING is server-wide, but it feeds\n  // `connectionPressureGovernor` — an IN-PROCESS AIMD governor that sheds THIS process's\n  // agent concurrency. Primary-only would leave every worker's governor unfed and silently\n  // disable its backpressure, which is a much worse failure than 16 extra cheap pgHealth()\n  // probes. Cost asymmetry decides it: this is one light query (classification\n  // 'must-sample', shed:false by design), whereas the host-scoped checks it sits beside\n  // cost hundreds of ms of DB work each.\n  scope: 'process',\n  tick: async () => {\n    const { pgHealth } = await import('../dev-data');\n    const h = await pgHealth().catch(() => null);\n    if (!h || h.maxConnections <= 0) return;\n\n    // C5-1: close the loop — feed saturation into the AIMD concurrency governor so\n    // critical PG saturation sheds agent concurrency (recovering as it falls).\n    // Gated by CONNECTION_PRESSURE_GOVERNOR (default ON); fail-OPEN to the default-on\n    // behavior so a flag-read error can't silently disable the backpressure. OFF ⇒\n    // signal-only (just the warn below) — the operator's escape hatch.\n    const { FLAGS } = await import('@papercusp/flags');\n    const { getFlag } = await import('@papercusp/flags/server');\n    const governorOn = await getFlag(\n      FLAGS.CONNECTION_PRESSURE_GOVERNOR,\n      'connection-pressure',\n    ).catch(() => true);\n    if (governorOn) connectionPressureGovernor.observe(h.saturationPct);\n\n    if (h.saturationPct >= 85) {\n      const top = h.byApplication\n        .slice(0, 6)\n        .map((a) => `${a.name}=${a.count}`)\n        .join(' ');\n      console.warn(\n        `[pg-pressure] DANGER ${h.serverWideConnections}/${h.maxConnections} conns ` +\n          `(${h.saturationPct}%). Top holders: ${top}. ` +\n          `Remedy: raise the ceiling (npx tsx scripts/pg-autotune.ts --apply), lower ` +"
    }
  ],
  "unresolved": [
    "Remaining descendants and external effects are not covered by immediate-source membership",
    "Configured shell/package descendants and persistence/migration/source-loading guard census",
    "Actual immutable candidate/platform/global-owner/provider/rollback/shipment acceptance"
  ],
  "ownedResidue": [],
  "revision2": {
    "observedAt": "2026-10-23T11:02:52.502Z",
    "sourceSnapshot": "runtime-migration/p001-tick-descendant-writer-snapshot-501c.json",
    "sourceSnapshotSha256": "f95219250d3c72d06dfb683e9b87d5a361707326e5f204cff4976916e7c3f4b9",
    "sourceSnapshotChars": 150645,
    "sourceOnly": true,
    "closureAccepted": false,
    "notes": {
      "dbos-history-ceiling": "Count workflow_status then alarm-attention resolve/escalate; cooldown is a prior-row read followed by notification, not an execution lease. Shared severe-event/attention transports remain transitive obligations. Shared alarm delivery/notification/coord sinks traced in runtime-migration/p001-shared-effect-sinks-501c.json; ordinary notifyAttention and no-msgId coord sends are not deterministic producer dedup/exclusive-owner proofs. No new execution proof.",
      "system-health": "compute.ts3736-3847 process-local in-flight map, snapshot+history+governor publication+SSE. History ticks uniqueness(workspace_id,at); transitions append; perf snapshot append after cadence read. computeSystemHealth collectors/incident capture not transitively closed.",
      "harness-status-sweep": "Existing sweep EI-26765683254627257 stays terminal; prior4integration+6unit proof unchanged and not rerun. Adjacent child cleanup EI-26766715329927110 now done, completionAuthority committed: actual spawn callback matches workspace/PID/start and requires successful registration. Red5FAIL/1PASS; green6integration+165unitPASS,0skip/substituted0,PGstopped. Native green exit envelope unavailable; runner PASS only. Canonical runtime-migration/p001-child-lane-redgreen-501c.json3003chars fully read back equal. Transitive lane lifecycle/global ownership closure remains incomplete.",
      "connection-pressure": "Prior process-local classification stands; no new execution proof.",
      "pg-tuning-drift": "Both drift functions read PG/sys state; defaultEmitToast inserts toast_log, deletes stale selected IDs for ring, SSE invalidation; no cross-process lease at writer.",
      "kernel-leak-watchdog": "defaultStore ONCONFLICT(boot_id,bucket_at); prune sample_at cutoff; alarm call uses broadcastSevereEvent/openEscalation with stable subject host:boot:signal. Descendant routing/projection effects not closed. Shared alarm delivery/notification/coord sinks traced in runtime-migration/p001-shared-effect-sinks-501c.json; ordinary notifyAttention and no-msgId coord sends are not deterministic producer dedup/exclusive-owner proofs. No new execution proof.",
      "host-contention-sampler": "runHostSampleOnce reads OS+contention and calls defaultStore ONCONFLICT(boot_id,bucket_at) DO NOTHING; limits stored sample rows, not owners.",
      "service-health": "runServiceHealthTick process-local lastHealth diff and probe result state; sendMessage without deterministic producer ID plus awaited event emission on transitions. probeAll and event transport descendants not closed.",
      "completion-ref-verify": "EI-26767601032456186 is done, completionAuthority committed. Observed completion_ref JSONB CAS+RETURNING fences found/not_found/error writes; both callers skip stale counters/backoff. Red24replacementFAIL/6unchangedPASS; green30integration+12unitPASS,0skip/substituted0,PGstopped. Canonical runtime-migration/p001-completion-ref-redgreen-501c.json3040chars fully read back equal. Backoff/toast/notification descendants and global ownership still not closed.",
      "spawn-reclaim-sweep": "spawn-reclaim SQL can UPDATE spawned_agents RETURNING and release exact dead spawn holder claims/planclaims; lifecycle artifact/wake/claim cleanup and remaining reclaim branches not closed.",
      "stale-claim-sweep": "Primary reclaim CTE FORUPDATE OF f SKIPLOCKED then UPDATE work_items; subsequent targeted lock cleanup and authority lease/audit/messages descendants. Remaining branches not closed.",
      "release-request-sweep": "release_request resolver CAS carries expected requester/holder/deadline/progress and stores consequence outbox. Replay has comment, targetedlocks,expectedAssignee release,stable-message/notifyOnce. Full consequence/settlement/transports not closed.",
      "learning-infra-health": "Process-local offline debounce and transition; writes toast_log/ringcleanup,sendMessage and SSE. Health leg collection and transport descendants not closed.",
      "steering-churn-sweep": "Atomic cooldown upsert WHERE last_escalated_ts<=cutoff then advisory; retention ts<cutoff DELETE. openEscalation routes to PG dedup transaction; full transport descendants not closed.",
      "federation-drain-reconcile": "Reads drain stats/status; watchdog issue lookup+3h closed-issue cooldown then recurrence comment or captureImprovement(open scope). Capture/comment sinks not closed; no global lease.",
      "pot-epoch-key-reconcile": "Default source path now traced to native sodium, OS/file keychain writes, committed HLC/capture definitions, outbox drain and buffered epoch reapply. Unreadable-key replacement reproduced and fixed as EI-26773090630864562:4 red faults/14controls; green22PASS0skip/substituted0/nativeexit0; hermetic keychain, real sodium. Canonical runtime-migration/p001-epoch-key-read-error-redgreen-501c.json4681chars fullreadbackequal; close receipt done/proposed (not shipment acceptance). Shared source leaves/hash identities in runtime-migration/p001-shared-effect-sinks-501c.json revision2. First-run key-creation exclusion, actual applied SQL/native/platform/candidate/global-owner remain unmeasured.",
      "shared-presence-reaper": "Current SQL:TTL DELETE last_seen_at<floor; cap DELETE joining ctid rank partition workspace/device. Config overrides; pure local retention. This is row retention, not cross-process ownership.",
      "scorecard-emission-pulse": "Freshness read then floor capture observation, optional standing issue payload repeat merge and watchdog-fires append. Wedge openEscalation stable subject. capture/compute-health/payload persistence descendants not closed.",
      "poll-suspect-scan": "Process-local lastAlertedAt; toast insert/ringcleanup then alarm-attention prior-notification read/broadcast/notify. Telemetry rollup and full alarm delivery not closed. Shared alarm delivery/notification/coord sinks traced in runtime-migration/p001-shared-effect-sinks-501c.json; ordinary notifyAttention and no-msgId coord sends are not deterministic producer dedup/exclusive-owner proofs. No new execution proof.",
      "timer-registration-scan": "Reads current/known timer names; toast BEFORE known-name persistence; INSERT known names ONCONFLICT(name) DO NOTHING bounds names only. Transport/schedule inventory descendants not closed."
    },
    "remaining": "Transitive mutation closure still incomplete; use explicit note leaves rather than repeat direct reads. Configured shell/package/persistence/migration/guard census and immutablecandidate/platform/globalowner/provider/rollback/ship remain.",
    "closedRepairs": [
      {
        "workItem": "EI-26767601032456186",
        "state": "done",
        "completionAuthority": "committed",
        "artifact": "runtime-migration/p001-completion-ref-redgreen-501c.json",
        "fullReadbackEqual": true,
        "chars": 3040
      },
      {
        "workItem": "EI-26766715329927110",
        "state": "done",
        "completionAuthority": "committed",
        "artifact": "runtime-migration/p001-child-lane-redgreen-501c.json",
        "fullReadbackEqual": true,
        "chars": 3003,
        "nativeGreenExit": null
      },
      {
        "workItem": "EI-26773090630864562",
        "stateAtClose": "done",
        "completionAuthorityAtClose": "proposed",
        "artifact": "runtime-migration/p001-epoch-key-read-error-redgreen-501c.json",
        "fullReadbackEqual": true,
        "chars": 4681
      }
    ],
    "evidenceScope": "Top-level sourceHashes/evidence retain original historical census snapshots; current repair source/test/log identities are in closedRepairs artifacts. No candidate/global-owner/deployment acceptance claimed.",
    "sharedSinkTrace": {
      "artifact": "runtime-migration/p001-shared-effect-sinks-501c.json",
      "chars": 12183,
      "sourceOnly": true,
      "closureAccepted": false,
      "revision": 2
    },
    "censusInterpretation": "inventorySources emits closureAccepted:false unconditionally as a source-discovery label; its keyword groups are candidates, not semantic runtime ownership proof or acceptance verdicts. Required/unreachable/external and unavailable-capacity classifications still need explicit evidence."
  }
}


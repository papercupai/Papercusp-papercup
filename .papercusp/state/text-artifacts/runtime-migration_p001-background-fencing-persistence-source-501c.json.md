---
rel_path: "runtime-migration/p001-background-fencing-persistence-source-501c.json"
updated_at: 1792749971024
_body: "content"
---

{
  "schema": "papercusp-background-fencing-persistence-source-v1",
  "workItem": "WI-6554700010022067",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "planItem": "P-001",
  "sourceOnly": true,
  "closureAccepted": false,
  "observedAt": "2026-10-23T10:05:16.197232+00:00",
  "commitObserved": "afe9d2e1ae751fbbf6786356db53947f90548340",
  "sources": [
    {
      "path": "packages/operator-core/lib/dbos/bootstrap.ts",
      "sha256": "5e6b2d22cb5b25effe96c2e052940356bb094e46b55c51c90653544a732b2e52",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 245,
          "end": 265,
          "text": " * but that also leaves its system-database pool open; shutdown is the only\n * supported path that destroys that pool and permits a fresh launch.\n */\nasync function cleanupFailedDbosLaunch(dbos: { shutdown: () => Promise<void> }): Promise<void> {\n  await dbos.shutdown();\n}\n\n/** The actual launch attempt. The public wrapper below coalesces callers. */\nasync function startDbosOnce(): Promise<void> {\n  if (G.__papercuspDbosStarted) return;\n\n  // EI-90: cheap env-only check before any PG probe / SDK import — refuse\n  // loudly rather than silently arming a second host under the primary's\n  // appVersion.\n  assertSafeDbosAppVersionPartition();\n\n  const { url, source } = getHarnessAdminUrlWithSource();\n  // Probe the resolved PG before launching. The source label can't distinguish\n  // a *dead* native-fallback (desktop product: :5432 is the retired\n  // papercusp_legacy) from a *live* one (dev box: :5432 IS the operator DB) —\n  // so connect-test instead: launch when reachable, skip cleanly when not."
        },
        {
          "start": 289,
          "end": 333,
          "text": "        import('./graceful-shutdown-recovery-credit'),\n        import('@dbos-inc/dbos-sdk'),\n      ]);\n      const credit = await consumeGracefulShutdownCredit({\n        sql: probe,\n        executorId: DbosForCredit.executorID,\n      });\n      if (credit.outcome === 'credited') {\n        console.log(\n          `[dbos-graceful-credit] previous ${credit.marker.signal} was graceful: credited ` +\n            `${credit.ids.length} in-flight workflow(s) on executor ${credit.marker.executorId}` +\n            `${credit.ids.length > 0 ? `: ${credit.ids.slice(0, 10).join(', ')}` : ''}`,\n        );\n      } else if (credit.outcome !== 'no-marker') {\n        console.warn(`[dbos-graceful-credit] marker not credited: ${JSON.stringify(credit)}`);\n      }\n    } catch (e) {\n      console.warn(\n        '[dbos-graceful-credit] boot credit failed (non-fatal), the restart counts as a recovery attempt:',\n        e instanceof Error ? e.message : e,\n      );\n    }\n    await probe.end({ timeout: 2 }).catch(() => {});\n  }\n\n  const { DBOS } = await import('@dbos-inc/dbos-sdk');\n  DBOS.setConfig({\n    name: 'papercusp-operator',\n    // Reuse the host's standard provider; DBOS preserves context across durable steps.\n    tracingEnabled: true,\n    systemDatabaseUrl: withDbosIdleTxGrace(url),\n    systemDatabaseSchemaName: 'dbos',\n    applicationVersion: PINNED_APP_VERSION,\n    // The operator shares a box with Restart (shop-api binds :3001); DBOS's\n    // admin server defaults to :3001 and would EADDRINUSE. We don't use it.\n    runAdminServer: false,\n  });\n\n  // Register workflows BEFORE launch so recovery + the scheduler can bind them.\n  await import('./hello-workflow');\n  // BYOC P-046 / D-100: every workspace-host provision enters this host-scoped\n  // dedup workflow. It is always registered because the route is flag-ON and a\n  // recovered in-flight host operation must bind even before a new request arrives.\n  const { registerWorkspaceHostProviderFactories } = await import('../workspace-host/provider-factories');\n  const { resolveHostedGcpAuth } = await import('../workspace-host/hosted-gcp-auth');"
        },
        {
          "start": 523,
          "end": 562,
          "text": "  // Same split: register before launch, wire the enqueue seam after.\n  const { wireRepairAutoVerify } = await import('./repair-auto-verify-workflow');\n  // P004: registration precedes launch so committed per-plan admissions recover after restart.\n  await import('./acceptance-grading-dispatch-workflow');\n\n  try {\n    await DBOS.launch();\n  } catch (err) {\n    if (!isRetryableDbosLaunchError(err)) throw err;\n\n    // DBOS creates its global executor before migrations run. A lock timeout\n    // therefore leaves an uninitialized executor + pool behind; retrying\n    // launch directly would leak one pool per attempt and can make the next\n    // attempt fail for an unrelated reason. Cleanup must settle before the\n    // bounded retry is armed. If cleanup itself fails, preserve the original\n    // initialization error and let the caller's loud failure path handle it.\n    try {\n      await cleanupFailedDbosLaunch(DBOS);\n    } catch (cleanupErr) {\n      console.warn(\n        '[dbos] failed to clean up the transient launch executor; retry not armed:',\n        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,\n      );\n      throw err;\n    }\n\n    const reason = err instanceof Error ? err.message : String(err);\n    console.warn(\n      `[dbos] transient system-database failure during launch (${reason}); ` +\n        'executor cleaned up and a bounded retry is armed',\n    );\n    armPgLaunchRetry(`DBOS launch transient failure: ${reason}`);\n    return;\n  }\n  G.__papercuspDbosStarted = true;\n  wireCheckpointEligibilityWait();\n  wireRepairAutoVerify();\n  console.log(`[dbos] launched (schema=dbos, source=${source}, appVersion=${PINNED_APP_VERSION})`);\n\n  // WI-10001739 link 3b — the hosted-lifecycle reconciler runs as `harness_app` and must read"
        },
        {
          "start": 585,
          "end": 597,
          "text": "  // wedges left by a prior crash/restart) plus a 2-min process-level sweep that runs\n  // OUTSIDE the DBOS routine engine, so it un-wedges the scheduler even when the\n  // routine engine is itself frozen. See dbos-executor-reaper.ts. Best-effort —\n  // must not fail boot.\n  try {\n    const [{ startExecutorReaper }, { getOrgPg }] = await Promise.all([\n      import('./dbos-executor-reaper'),\n      import('@papercusp/db-org'),\n    ]);\n    startExecutorReaper(getOrgPg().sql);\n    // EI-19451658870832332 — ARMING RECEIPT. The reaper is provably executing (its\n    // dead-executor scan increments in pg_stat_statements on the 120s cadence) while\n    // being ABSENT from every `listManaged()` read served by /api/internal/managed-timers"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/dbos/ephemeral-executor.ts",
      "sha256": "debbfeef601f5f3d9d51108a0e3d35b2ef3360404431505e41596294bed97737",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 98,
          "end": 139,
          "text": "let invalidationListenHookStop: (() => void) | null = null;\n\nconst logWith = (deps: EphemeralExecutorDeps, msg: string): void =>\n  (deps.log ?? ((m: string) => console.log(`[ephemeral-executor] ${m}`)))(msg);\n\n/** Arm ONE ephemeral routine as a managed timer (category 'ephemeral-harness'). */\nfunction armOne(spec: EphemeralRoutineSpec, deps: EphemeralExecutorDeps): ArmedEphemeral {\n  const intervalSec = Math.max(EPHEMERAL_MIN_INTERVAL_SEC, Math.floor(spec.intervalSec));\n  const handle = managedSetInterval(\n    `ephemeral:${spec.id}`,\n    intervalSec * 1000,\n    async () => {\n      let err: string | null = null;\n      try {\n        const result = await deps.fire(spec);\n        // WI-10005164: a fail-soft sub-pass failure. Recorded like a throw so the\n        // routine stops reading healthy, but not logged here: the action logs it\n        // when it happens, and a sticky failure would repeat this line every tick.\n        if (result && typeof result.softError === 'string' && result.softError) err = result.softError;\n      } catch (e) {\n        err = e instanceof Error ? e.message : String(e);\n        logWith(deps, `fire failed for ${spec.id} (${spec.targetRole}): ${err}`);\n      }\n      // D-004: per-schedule durable liveness — UPDATE one row, never INSERT per fire.\n      try {\n        await deps.recordFire(spec, err);\n      } catch {\n        /* best-effort: liveness must never crash the tick */\n      }\n    },\n    // The registry's re-entrancy guard + shed gate; ephemeral fires are bounded sweeps → shed-eligible.\n    { category: 'ephemeral-harness', shed: true },\n  );\n  return { spec, handle };\n}\n\n/**\n * Arm the per-host ephemeral executor. IDEMPOTENT (a second call is a no-op). Call ONCE from\n * host-bootstrap under the single-owner gate (`backgroundWorkers && !utilityHost`).\n */\nexport async function armEphemeralExecutor(deps: EphemeralExecutorDeps): Promise<{ stop: () => void }> {\n  if (armed) return { stop: disarmEphemeralExecutor };"
        },
        {
          "start": 281,
          "end": 352,
          "text": "export function productionEphemeralExecutorDeps(): EphemeralExecutorDeps {\n  return {\n    list: async () => {\n      const out: EphemeralRoutineSpec[] = [];\n      for (const ws of backgroundWorkspaceIds()) {\n        const rows = await runWithWorkspace(ws, () => {\n          const { sql } = getOrgPg();\n          return listActiveEphemeralRoutines(sql);\n        });\n        for (const r of rows) {\n          const intervalSec = Number(r.triggerConfig?.interval_sec);\n          if (!Number.isFinite(intervalSec) || intervalSec <= 0) {\n            console.warn(`[ephemeral-executor] skipping ${r.id}: missing/invalid interval_sec`);\n            continue;\n          }\n          if (intervalSec > EPHEMERAL_MAX_INTERVAL_SEC) {\n            // WI-1406487: still armed (see EPHEMERAL_MAX_INTERVAL_SEC), but never again\n            // silently. Without this line the ONLY trace of an unfireable routine is a\n            // cheerful \"armed\" log, which is what made corpus-term-df invisible for 35.7h.\n            console.warn(\n              `[ephemeral-executor] UNFIREABLE-CADENCE ${r.name} (${r.id}): interval_sec ${intervalSec}s ` +\n                `> ${EPHEMERAL_MAX_INTERVAL_SEC}s. This timer re-arms from zero on every host restart, so it ` +\n                `only fires if the host stays up ${Math.ceil(intervalSec / 60)}min continuously — it will most ` +\n                `likely NEVER fire. Move it to tier:durable with a cron (next_fire_at survives restarts).`,\n            );\n          }\n          out.push({\n            id: r.id,\n            workspaceId: r.workspaceId,\n            installSlug: r.installSlug,\n            name: r.name,\n            targetRole: r.targetRole,\n            intervalSec,\n            payloadTemplate: r.payloadTemplate,\n            triggerConfig: r.triggerConfig,\n          });\n        }\n      }\n      return out;\n    },\n    fire: async (r) => {\n      // Deterministic-action-only: blueprint:validate guarantees an ephemeral action is a concrete\n      // system:<x>. A non-system role is out of contract for this bounded in-process fire path.\n      if (!r.targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {\n        throw new Error(`ephemeral routine ${r.id} targetRole \"${r.targetRole}\" is not a ${SYSTEM_TARGET_PREFIX}action`);\n      }\n      const name = r.targetRole.slice(SYSTEM_TARGET_PREFIX.length);\n      const action = getSystemAction(name);\n      if (!action) throw new Error(`no system action \"${name}\" registered (ephemeral routine ${r.id})`);\n      // WI-10005745 (D-012): same restricted-hold skip as the durable routine workflow.\n      const skip = await restrictedTreeSkipReason(name, getSystemActionEntry(name));\n      if (skip) {\n        console.warn(`[ephemeral] ${skip} (routine ${r.id})`);\n        return { diagnostics: { restrictedHoldSkip: skip } };\n      }\n      return await runWithWorkspace(r.workspaceId, () =>\n        action({\n          installSlug: r.installSlug,\n          workspaceId: r.workspaceId,\n          triggerConfig: r.triggerConfig,\n          payloadTemplate: r.payloadTemplate,\n        }),\n      );\n    },\n    recordFire: async (r, error) => {\n      await runWithWorkspace(r.workspaceId, () => {\n        const { sql } = getOrgPg();\n        return recordEphemeralFire(sql, r.id, error);\n      });\n    },\n  };\n}"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/dbos/in-process-sweep-arm.ts",
      "sha256": "a0f69cea6845740cfcb5c141ba9bb9034a463dee1a39105ed399edcd8c22a98b",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 94,
          "end": 116,
          "text": " *\n * A sweep is host-scoped but a routines row is workspace-scoped, so one sweep can have several\n * rows. Disabled ⇔ ANY of them says `active=false`. That is what the click MEANS: an owner who\n * turns `system-health` off in the pane is asking for the host sweep to stop, not for it to stop\n * in one workspace and keep running in another (which the single host timer cannot express\n * anyway). Re-enabling in that same workspace clears it; a sweep another workspace also disabled\n * stays off, which is likewise the honest answer.\n */\nexport async function readDisabledSweeps(): Promise<Set<string>> {\n  const disabled = new Set<string>();\n  for (const ws of backgroundWorkspaceIds()) {\n    const rows = await runWithWorkspace(ws, () => {\n      const { sql } = getOrgPg();\n      return listInProcessSweepRoutines(sql);\n    });\n    for (const r of rows) if (r.active === false) disabled.add(r.name);\n  }\n  return disabled;\n}\n\n/**\n * Materialize one arm-state row per declared sweep, so the pane has something to toggle.\n *"
        },
        {
          "start": 127,
          "end": 158,
          "text": "    await runWithWorkspace(ws, async () => {\n      const { sql } = getOrgPg();\n      for (const spec of specs) {\n        const id = `rt_${slug}_${spec.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();\n        await sql`\n          INSERT INTO harness_shared.routines\n            (id, install_slug, name, trigger_kind, trigger_config, target_role,\n             concurrency, catchup, active, tier, next_fire_at, reschedule_interval_sec, workspace_id)\n          VALUES (\n            ${id}, ${slug}, ${spec.name}, 'in-process',\n            ${'{}'}::text::jsonb, ${IN_PROCESS_SWEEP_TARGET_ROLE},\n            'skip', 'skip-old', TRUE, 'in-process', NULL,\n            ${Math.max(1, Math.round(spec.intervalMs / 1000))}, ${ws}\n          )\n          ON CONFLICT (install_slug, name) DO UPDATE SET\n            trigger_kind            = EXCLUDED.trigger_kind,\n            target_role             = EXCLUDED.target_role,\n            tier                    = EXCLUDED.tier,\n            reschedule_interval_sec = EXCLUDED.reschedule_interval_sec,\n            -- active intentionally NOT re-applied: a boot-time re-seed must never undo a pause.\n            workspace_id            = EXCLUDED.workspace_id,\n            updated_at              = now()\n        `;\n        written += 1;\n      }\n    });\n  }\n  return written;\n}\n\n/** The seam the reconciler drives. Injected so the unit test needs no database and no timers. */\nexport interface SweepArmReconcilerDeps {"
        },
        {
          "start": 184,
          "end": 209,
          "text": "    // FAIL-OPEN. A database that cannot answer must never be read as \"the owner disabled\n    // everything\" — that would silently stop system-health and the stale-claim sweeps fleet-wide.\n    deps.warn?.(\n      `[in-process-sweep-arm] arm-state read failed; leaving every sweep ARMED: ${\n        err instanceof Error ? err.message : String(err)\n      }`,\n    );\n    return { toStop: [], toStart: [] };\n  }\n  const plan = planSweepReconcile({\n    eligible: deps.eligible().map((s) => s.name),\n    armed: deps.armed(),\n    disabled,\n  });\n  if (plan.toStop.length === 0 && plan.toStart.length === 0) return plan;\n  const applied = deps.apply(plan);\n  if (applied.toStop.length > 0 || applied.toStart.length > 0) {\n    deps.log?.(\n      `[in-process-sweep-arm] reconciled: stopped [${applied.toStop.join(', ')}], ` +\n        `started [${applied.toStart.join(', ')}]`,\n    );\n  }\n  return applied;\n}\n\nlet reconciler: ManagedHandle | null = null;"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/dbos/in-process-periodic.ts",
      "sha256": "1cb972f5dcb0cd39d5bc0d9f03b602f05acdd4a501d78243cfd883b36bb933bc",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 98,
          "end": 108,
          "text": "   * item on it.\n   */\n  scope?: 'host' | 'process';\n  tick: () => Promise<void> | void;\n}\n\n/** Whether `check` should run in THIS process. Exported pure for the unit test. */\nexport function checkRunsInThisProcess(check: PeriodicCheck, isPrimary: boolean): boolean {\n  return isPrimary || check.scope === 'process';\n}\n"
        },
        {
          "start": 1523,
          "end": 1547,
          "text": "export function buildDefaultChecks(): PeriodicCheck[] {\n  return [\n    dbosHistoryCeilingCheck,\n    systemHealthCheck,\n    harnessStatusSweepCheck,\n    connectionPressureCheck,\n    pgTuningDriftCheck,\n    kernelLeakCheck,\n    hostContentionSamplerCheck,\n    serviceHealthCheck,\n    completionRefVerifyCheck,\n    spawnReclaimSweepCheck,\n    staleClaimSweepCheck,\n    releaseRequestSweepCheck,\n    learningInfraHealthCheck,\n    steeringChurnSweepCheck,\n    federationDrainReconcileCheck,\n    hiveEpochKeyReconcileCheck,\n    sharedPresenceReaperCheck,\n    scorecardEmissionPulseCheck,\n    pollSuspectScanCheck,\n    timerRegistrationScanCheck,\n  ];\n}\n"
        },
        {
          "start": 1565,
          "end": 1579,
          "text": "/** Arm ONE check on the shared registry. The single place the registration options are built. */\nfunction armOneCheck(check: PeriodicCheck): ArmedCheck {\n  return {\n    name: check.name,\n    // Return the tick's PROMISE to the registry — `() => void runPeriodicCheck(...)` discarded it, which\n    // made every tick look SYNCHRONOUS to managedSetInterval, so its re-entrancy guard released before the\n    // async tick finished and a slow tick could fire concurrently (the re-entrancy-guard test caught this;\n    // gate-red 2026-07-01). runPeriodicCheck never rejects (it catches internally).\n    handle: managedSetInterval(check.name, check.intervalMs, () => runPeriodicCheck(check, armDeps).then(() => undefined), {\n      category: 'global-sweep',\n      shed: check.shed,\n      fireOnArm: check.fireOnArm,\n      classification: check.classification,\n    }),\n  };"
        },
        {
          "start": 1603,
          "end": 1624,
          "text": "  if (armed) return { stop: disarmInProcessPeriodicChecks };\n  installManagedTickAlarm();\n  const all = opts.checks ?? buildDefaultChecks();\n  // P-018: in a node cluster, only the PRIMARY runs the host-scoped sweeps — see\n  // PeriodicCheck.scope for why `backgroundWorkersEnabled()` never actually provided this.\n  // `isPrimary` is injectable so the test can exercise the worker branch without forking.\n  const isPrimary = opts.isPrimary ?? nodeCluster.isPrimary;\n  const checks = all.filter((c) => checkRunsInThisProcess(c, isPrimary));\n  const skipped = all.length - checks.length;\n  // EI-19294826146331487: arm EVERYTHING first, unconditionally and with no database read on the\n  // boot path, exactly as before. The durable arm state is applied afterwards by the reconciler\n  // (`applyInProcessSweepArmState`), so a slow or wedged database can never delay host boot, and\n  // the worst case is one reconcile interval of an already-running sweep.\n  eligibleChecks = checks;\n  armDeps = opts.deps;\n  armed = checks.map(armOneCheck);\n  console.log(\n    `[in-process-periodic] armed ${checks.length} in-process check(s)` +\n      `${isPrimary ? '' : ` (cluster WORKER — ${skipped} host-scoped check(s) left to the primary, P-018)`}` +\n      `: ${checks.map((c) => c.name).join(', ')}`,\n  );\n  return { stop: disarmInProcessPeriodicChecks };"
        }
      ]
    },
    {
      "path": "libs/papercusp/libs/db/src/routines-runtime.ts",
      "sha256": "c7e6cb9db68640e5320066983d724a32ca3f28b592fdb70423e7c3544882bc26",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 127,
          "end": 136,
          "text": "export async function listActiveEphemeralRoutines(sql: Sql): Promise<RoutineRow[]> {\n  const rows = await sql<any[]>`\n    SELECT * FROM harness_shared.routines\n     WHERE active = TRUE\n       AND tier = 'ephemeral'\n     ORDER BY id ASC\n  `;\n  return rows.map(rowToRoutine);\n}\n"
        },
        {
          "start": 148,
          "end": 179,
          "text": " */\nexport async function listInProcessSweepRoutines(sql: Sql): Promise<RoutineRow[]> {\n  const rows = await sql<any[]>`\n    SELECT * FROM harness_shared.routines\n     WHERE tier = 'in-process'\n     ORDER BY name ASC, id ASC\n  `;\n  return rows.map(rowToRoutine);\n}\n\n/**\n * Per-schedule durable liveness for an ephemeral fire (D-004: UPDATE ONE row per schedule,\n * never INSERT per fire — this is exactly how the EI-1622 workflow_status bloat is avoided by\n * construction). Stamps last_fired_at; on error records metadata.last_error/last_error_at, on\n * success clears last_error.\n */\nexport async function recordEphemeralFire(sql: Sql, routineId: string, error: string | null): Promise<void> {\n  const metaPatch = JSON.stringify(\n    error == null\n      ? { last_error: null, last_error_at: null }\n      : { last_error: error, last_error_at: new Date().toISOString(), last_error_source: 'ephemeral-executor' },\n  );\n  await sql`\n    UPDATE harness_shared.routines\n       SET last_fired_at = now(),\n           metadata = COALESCE(metadata, '{}'::jsonb) || ${metaPatch}::text::jsonb,\n           updated_at = now()\n     WHERE id = ${routineId}\n  `;\n}\n\n/**"
        }
      ]
    },
    {
      "path": "libs/generic/scheduled-registry/src/index.ts",
      "sha256": "4c51f07a8a6f5430ce01426e2d05822fa05d8069c7db23c302e669b970b1d16b",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 315,
          "end": 342,
          "text": " * The pin key. Also the id this module reports under in\n * `listModuleDuplications()`, so a split here is visible in the REALM-WIDE\n * duplication report rather than only through this module's own accessor.\n */\nconst STATE_KEY = '@papercusp/scheduled-registry.state';\n\n/**\n * Pinned + counted by `@papercusp/module-singleton` rather than hand-rolled here.\n *\n * This module was the FIRST subject of the split (EI-19451658870832332) and its\n * fix was written inline, before the primitive existed. Keeping that copy would\n * have been the more expensive kind of duplication: `listModuleDuplications()`\n * only knows about keys pinned THROUGH the primitive, so the one module known to\n * split in production would have been the one module missing from the central\n * report — the same \"the detector cannot see its subject\" shape as the original\n * bug (EI-19463700807328229).\n *\n * Calling `pinModuleState` at module scope is what makes the count a count of\n * module RECORDS: it must run exactly once per evaluation of this body, so it\n * must never be moved inside a function.\n */\nconst state: RegistryState = pinModuleState<RegistryState>(STATE_KEY, () => ({\n  registry: new Map<string, InternalRecord>(),\n  instanceCounter: 0,\n  resolved: defaults(),\n  episodeCounter: 0,\n}));\n"
        },
        {
          "start": 394,
          "end": 427,
          "text": "    rec.episodeSkips = 0;\n  };\n  return () => {\n    if (rec.stopped) return;\n    if (rec.running) {\n      // Re-entrancy guard: a slow tick never piles up a second run. Count the swallowed fire and\n      // report a tick that has held the guard for several intervals, since nothing else will.\n      rec.episodeSkips += 1;\n      rec.entry.skippedWhileRunning += 1;\n      if (shouldReportSkip(rec.episodeSkips) && rec.entry.runningSince !== null) {\n        state.resolved.log(\n          `${name} tick still running after ${state.resolved.now() - rec.entry.runningSince}ms ` +\n            `(${rec.episodeSkips} fire(s) skipped by the re-entrancy guard, interval ${rec.entry.intervalMs}ms)`,\n        );\n      }\n      return;\n    }\n    if (opts.shed && state.resolved.shouldShed(name)) return; // shed this cycle under load\n    rec.running = true;\n    rec.entry.running = true;\n    rec.entry.runningSince = state.resolved.now();\n    rec.episodeSkips = 0;\n    // Run a SYNCHRONOUS tick synchronously — this preserves the bare-setInterval timing\n    // semantics (a sync watchdog tick must complete in THIS turn, not a deferred microtask);\n    // only a genuinely-async tick (returns a thenable) is awaited, so the re-entrancy guard\n    // still holds across a slow async run.\n    let result: void | Promise<void>;\n    try {\n      result = fn();\n    } catch (e) {\n      settle(e);\n      return;\n    }\n    if (result && typeof (result as Promise<void>).then === 'function') {"
        },
        {
          "start": 548,
          "end": 562,
          "text": "    if (!instanced) stopManaged(name);\n    return { stop: () => undefined };\n  }\n  // Singletons key by name (re-arming replaces); instanced timers get a unique key so many\n  // coexist under one display name (aggregated in listManaged).\n  const key = instanced ? `${name}#${(state.instanceCounter += 1)}` : name;\n  if (!instanced && registry.has(key)) {\n    // Idempotent re-arm: silently stop the previous timer and register fresh. No warn —\n    // host watchdogs re-arm across boot retries / test cases, and the inventory always\n    // reflects the single latest registration. (A genuine name COLLISION is a code-review\n    // concern surfaced by two distinct sites sharing a name, not a runtime warning.)\n    stopManaged(key);\n  }\n  const entry: ManagedEntry = {\n    name,"
        }
      ]
    },
    {
      "path": "libs/generic/module-singleton/src/index.ts",
      "sha256": "4d8852efe38c7fddf07a77c821ba0bb704df0e52c7324182a2941db564712dbf",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 82,
          "end": 94,
          "text": "const SLOTS_KEY = Symbol.for('@papercusp/module-singleton.slots');\n\nfunction slots(): Map<string, Slot> {\n  const store = globalThis as unknown as Record<symbol, Map<string, Slot> | undefined>;\n  let map = store[SLOTS_KEY];\n  if (!map) {\n    map = new Map<string, Slot>();\n    store[SLOTS_KEY] = map;\n  }\n  return map;\n}\n\n/**"
        },
        {
          "start": 107,
          "end": 123,
          "text": "  if (typeof key !== 'string' || key.length === 0) {\n    throw new TypeError('pinModuleState: key must be a non-empty string');\n  }\n  const map = slots();\n  const now = Date.now();\n  const existing = map.get(key);\n  if (existing) {\n    existing.evaluations += 1;\n    existing.lastSeenAt = now;\n    return existing.value as T;\n  }\n  const value = init();\n  map.set(key, { value, evaluations: 1, firstSeenAt: now, lastSeenAt: now });\n  return value;\n}\n\n/** Read an existing pin without initializing it or counting a module evaluation. */"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/dbos/graceful-shutdown-recovery-credit.ts",
      "sha256": "d0b9af098ba3541ce7b8140dc745fa4e5af1098657ea678bab7922a69c401164",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 69,
          "end": 105,
          "text": " * Give one recovery attempt back to every PENDING, deadline-bounded workflow owned by\n * `executorId`. Returns the ids credited. Never drops below zero.\n */\nexport async function creditGracefulShutdownRecoveryAttempts(\n  sql: CreditSql,\n  executorId: string,\n): Promise<string[]> {\n  if (!executorId) return [];\n  const rows = await sql.begin(async (tx) => {\n    await tx.unsafe(\n      `SET LOCAL statement_timeout = ${GRACEFUL_RECOVERY_CREDIT_STATEMENT_TIMEOUT_MS}`,\n    );\n    return tx<{ workflow_uuid: string }[]>`\n      UPDATE dbos.workflow_status\n         SET recovery_attempts = recovery_attempts - 1\n       WHERE executor_id = ${executorId}\n         AND status = 'PENDING'\n         AND recovery_attempts > 0\n         AND workflow_deadline_epoch_ms IS NOT NULL\n      RETURNING workflow_uuid`;\n  });\n  return (rows as unknown as { workflow_uuid: string }[]).map((r) => r.workflow_uuid);\n}\n\nexport interface GracefulShutdownMarker {\n  schema: typeof GRACEFUL_SHUTDOWN_MARKER_SCHEMA;\n  executorId: string;\n  pid: number;\n  signal: 'SIGTERM' | 'SIGINT';\n  /** epoch ms */\n  at: number;\n}\n\n/** `$PAPERCUSP_HOME/run` (default `~/.papercusp/run`). */\nexport function defaultGracefulShutdownMarkerDir(env: NodeJS.ProcessEnv = process.env): string {\n  return join(papercuspHome(env), 'run');\n}"
        },
        {
          "start": 225,
          "end": 269,
          "text": "  opts: ConsumeGracefulShutdownCreditOptions,\n): Promise<GracefulShutdownCreditResult> {\n  if (!opts.executorId) return { outcome: 'invalid', reason: 'no executor id' };\n  const dir = opts.markerDir ?? defaultGracefulShutdownMarkerDir();\n  const path = gracefulShutdownMarkerPath(dir, opts.executorId);\n  let raw: string;\n  try {\n    raw = readFileSync(path, 'utf8');\n  } catch (e) {\n    if (errCode(e) === 'ENOENT') return { outcome: 'no-marker' };\n    throw e;\n  }\n  // Consume first: a failure after this point loses one credit (the pre-fix behaviour)\n  // and can never credit the same shutdown twice.\n  try {\n    unlinkSync(path);\n  } catch (e) {\n    if (errCode(e) !== 'ENOENT') throw e;\n  }\n\n  let marker: GracefulShutdownMarker;\n  try {\n    marker = JSON.parse(raw) as GracefulShutdownMarker;\n  } catch {\n    return { outcome: 'invalid', reason: 'unparseable marker' };\n  }\n  if (!marker || marker.schema !== GRACEFUL_SHUTDOWN_MARKER_SCHEMA) {\n    return { outcome: 'invalid', reason: 'unknown marker schema' };\n  }\n  if (marker.executorId !== opts.executorId) {\n    return { outcome: 'invalid', reason: `marker is for executor ${String(marker.executorId)}` };\n  }\n  if (typeof marker.at !== 'number' || !Number.isFinite(marker.at)) {\n    return { outcome: 'invalid', reason: 'marker has no timestamp' };\n  }\n  if (marker.pid === (opts.pid ?? process.pid)) {\n    return { outcome: 'invalid', reason: 'marker was written by this process' };\n  }\n  const ageMs = (opts.now ?? Date.now)() - marker.at;\n  if (ageMs < 0 || ageMs > (opts.maxAgeMs ?? GRACEFUL_SHUTDOWN_MARKER_MAX_AGE_MS)) {\n    return { outcome: 'stale', ageMs };\n  }\n  const ids = await creditGracefulShutdownRecoveryAttempts(opts.sql, opts.executorId);\n  return { outcome: 'credited', ids, marker };\n}"
        }
      ]
    },
    {
      "path": "node_modules/@dbos-inc/dbos-sdk/dist/src/dbos-executor.js",
      "sha256": "d6a4e51e3a22d77fb25efae9a95e83e12f6d7332f273d6d1181cf8a5a63681ae",
      "sourcePlane": "installed-dependency-unbound-to-lock-tarball",
      "windows": [
        {
          "start": 150,
          "end": 158,
          "text": "            }\n        }\n        this.logger.info(`Initializing DBOS (v${utils_1.globalParams.dbosVersion})`);\n        this.logger.info(`System Database URL: ${(0, database_utils_1.maskDatabaseUrl)(this.config.systemDatabaseUrl)}`);\n        this.logger.info(`Executor ID: ${this.executorID}`);\n        this.logger.info(`Application version: ${utils_1.globalParams.appVersion}`);\n        await this.recoverPendingWorkflows([this.executorID]);\n        this.logger.info('DBOS launched!');\n    }"
        },
        {
          "start": 859,
          "end": 875,
          "text": "    async recoverPendingWorkflows(executorIDs = ['local']) {\n        const handlerArray = [];\n        for (const execID of executorIDs) {\n            this.logger.debug(`Recovering workflows assigned to executor: ${execID}`);\n            const recoveredWorkflowIDs = await this.systemDatabase.reenqueueWorkflowsForRecovery(execID, utils_1.globalParams.appVersion, utils_1.INTERNAL_QUEUE_NAME);\n            if (recoveredWorkflowIDs.length > 0) {\n                this.logger.info(`Recovering ${recoveredWorkflowIDs.length} workflows from application version ${utils_1.globalParams.appVersion}`);\n            }\n            else {\n                this.logger.info(`No workflows to recover from application version ${utils_1.globalParams.appVersion}`);\n            }\n            for (const workflowID of recoveredWorkflowIDs) {\n                handlerArray.push(this.retrieveWorkflow(workflowID));\n            }\n        }\n        return handlerArray;\n    }"
        }
      ]
    },
    {
      "path": "node_modules/@dbos-inc/dbos-sdk/dist/src/system_database.js",
      "sha256": "b8594818c046779927f646b94aa6a159ac1d97655a88bfdd451dbe494858bf55",
      "sourcePlane": "installed-dependency-unbound-to-lock-tarball",
      "windows": [
        {
          "start": 910,
          "end": 941,
          "text": "    async getPendingWorkflows(executorID, appVersion) {\n        const params = [workflow_1.StatusString.PENDING, executorID, appVersion];\n        // executor_id defaults to \"local\", so it collides across applications.\n        const scope = this.#appNameFilter('application_name', this.appName, params);\n        const getWorkflows = await this.pool.query(`SELECT workflow_uuid\n       FROM \"${this.schemaName}\".workflow_status\n       WHERE status=$1 AND executor_id=$2 AND application_version=$3 AND ${scope}`, params);\n        return getWorkflows.rows.map((i) => ({\n            workflowUUID: i.workflow_uuid,\n        }));\n    }\n    // Recovery re-enqueues rather than executing directly so the queue's atomic dequeue admits exactly one runner, and the executor ID predicate rejects sweeps for rows a live executor has already claimed.\n    async reenqueueWorkflowsForRecovery(executorID, appVersion, recoveryQueueName) {\n        const params = [workflow_1.StatusString.ENQUEUED, recoveryQueueName, workflow_1.StatusString.PENDING, executorID, appVersion];\n        // executor_id defaults to \"local\", so it collides across applications.\n        const scope = this.#appNameFilter('application_name', this.appName, params);\n        const result = await this.pool.query(`UPDATE \"${this.schemaName}\".workflow_status\n       SET started_at_epoch_ms = NULL,\n           status = $1,\n           updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint,\n           queue_name = COALESCE(queue_name, $2)\n       WHERE status = $3\n         AND executor_id = $4\n         AND application_version = $5\n         AND ${scope}\n       RETURNING workflow_uuid`, params);\n        return result.rows.map((row) => row.workflow_uuid);\n    }\n    async getWorkflowStatus(workflowID, callerID, callerFN) {\n        const funcGetStatus = async () => {\n            const statuses = await this.listWorkflows({ workflowIDs: [workflowID] });\n            const status = statuses.find((s) => s.workflowUUID === workflowID);"
        },
        {
          "start": 2420,
          "end": 2441,
          "text": "    async findAndMarkStartableWorkflows(queue, executorID, appVersion, queuePartitionKey, localRunningCount = 0, partitionLocalRunningCount = 0) {\n        const claimedIDs = [];\n        const limits = (0, wfqueue_1.resolveQueueLimits)(queue);\n        const partitionParams = queuePartitionKey !== undefined ? [queuePartitionKey] : [];\n        // Shares a concurrency or rate limit budget with other executors.\n        const hasSharedBudget = limits.globalConcurrency !== undefined ||\n            limits.partitionConcurrency !== undefined ||\n            limits.rateLimit !== undefined ||\n            limits.partitionRateLimit !== undefined;\n        // Shares that budget across partitions too, so sweeps of different partitions read disjoint rows and could each spend it.\n        const hasWriteSkew = queuePartitionKey !== undefined && (limits.globalConcurrency !== undefined || limits.rateLimit !== undefined);\n        const client = await this.#connect();\n        try {\n            // Default to READ COMMITTED except with a budget shared across executors\n            if (hasSharedBudget) {\n                await client.query(`BEGIN ISOLATION LEVEL ${hasWriteSkew ? 'SERIALIZABLE' : 'REPEATABLE READ'}`);\n            }\n            else {\n                await client.query('BEGIN');\n            }\n            /** Slots left in a rate limit's rolling window, at the scope that limit applies to. */\n            const rateLimitRemaining = async (rateLimit, partitionScoped) => {"
        },
        {
          "start": 2514,
          "end": 2584,
          "text": "            const latestVersion = await this.#latestApplicationVersionName(client);\n            const isLatestVersion = latestVersion === undefined || latestVersion === appVersion;\n            const versionClause = isLatestVersion\n                ? '(application_version = $3 OR application_version IS NULL)'\n                : 'application_version = $3';\n            // A limit shared across processes needs a consistent view of the table: NOWAIT makes an\n            // overlapping dequeuer abort rather than claim the next rows and spend the same budget twice.\n            const lockMode = hasSharedBudget ? 'FOR UPDATE NOWAIT' : 'FOR UPDATE SKIP LOCKED';\n            const limitClause = maxTasks !== Infinity ? `LIMIT ${maxTasks}` : '';\n            const selectParams = [workflow_1.StatusString.ENQUEUED, queue.name, appVersion, ...partitionParams];\n            const selectScope = this.#appNameFilter('application_name', this.appName, selectParams);\n            const selectQuery = `\n        SELECT workflow_uuid\n        FROM \"${this.schemaName}\".workflow_status\n        WHERE status = $1\n          AND queue_name = $2\n          AND ${versionClause}\n          AND ${selectScope}\n          ${queuePartitionKey !== undefined ? 'AND queue_partition_key = $4' : ''}\n        ORDER BY priority ASC, created_at ASC\n        ${limitClause}\n        ${lockMode}\n      `;\n            const { rows } = await client.query(selectQuery, selectParams);\n            // Fires while the SELECT FOR UPDATE lock is held — tests can throw a\n            // synthetic 55P03 here to simulate a concurrent executor winning the race.\n            await (0, debugpoint_1.debugTriggerPoint)(debugpoint_1.DEBUG_TRIGGER_FIND_AND_MARK_AFTER_SELECT);\n            // Start the workflows\n            const workflowIDs = rows.map((row) => row.workflow_uuid);\n            if (workflowIDs.length > 0) {\n                // Start the functions by marking them as pending and updating their executor IDs.\n                const updateParams = [\n                    workflow_1.StatusString.PENDING,\n                    executorID,\n                    appVersion,\n                    limits.rateLimit !== undefined || limits.partitionRateLimit !== undefined,\n                    workflowIDs,\n                    workflow_1.StatusString.ENQUEUED,\n                    // Claim an unclaimed row for this application; a nameless dequeuer leaves ownership untouched.\n                    this.appName ?? null,\n                ];\n                // Re-check ownership alongside status, as the partitioned claim guard does.\n                const claimScope = this.#appNameFilter('application_name', this.appName, updateParams);\n                // RETURNING reports exactly the rows this statement flipped, so a row another worker won is absent.\n                const flippedResult = await client.query(`UPDATE \"${this.schemaName}\".workflow_status\n           SET status = $1,\n               executor_id = $2,\n               application_version = $3,\n               started_at_epoch_ms = (EXTRACT(epoch FROM now()) * 1000)::bigint,\n               rate_limited = $4,\n               application_name = COALESCE(application_name, $7),\n               recovery_attempts = recovery_attempts + 1,\n               updated_at = (EXTRACT(epoch FROM now()) * 1000)::bigint,\n               workflow_deadline_epoch_ms = CASE\n                 WHEN workflow_timeout_ms IS NOT NULL AND workflow_deadline_epoch_ms IS NULL\n                 THEN (EXTRACT(epoch FROM now()) * 1000)::bigint + workflow_timeout_ms\n                 ELSE workflow_deadline_epoch_ms\n               END\n           WHERE workflow_uuid = ANY($5::text[]) AND status = $6 AND ${claimScope}\n           RETURNING workflow_uuid`, updateParams);\n                const flippedIDs = new Set(flippedResult.rows.map((row) => row.workflow_uuid));\n                for (const id of workflowIDs) {\n                    if (flippedIDs.has(id))\n                        claimedIDs.push(id);\n                }\n            }\n            await client.query('COMMIT');\n        }\n        catch (error) {\n            await client.query('ROLLBACK');\n            throw error;"
        }
      ]
    },
    {
      "path": "apps/operator/bin/host-bootstrap.ts",
      "sha256": "ec212f18b6c4d9f5eff93b7726698cc781dde06e22613accbd6d6a93cd74e28c",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 2382,
          "end": 2436,
          "text": "        } catch (err) {\n          console.warn('[spawn-reclaim] boot reconcile failed (non-fatal):', err instanceof Error ? err.message : err);\n        }\n        }\n\n        const {\n          armInProcessPeriodicChecks,\n          inProcessPeriodicEligibleChecks,\n          inProcessPeriodicArmedNames,\n          applyInProcessSweepArmState,\n        } = await import('@papercusp/operator-core/lib/dbos/in-process-periodic');\n        armInProcessPeriodicChecks();\n\n        // EI-19294826146331487 — the sweeps armed above are DECLARED IN CODE, so until now the\n        // Automation pane could list them but offered no switch. Their durable on/off state lives\n        // in `harness_shared.routines` as `tier='in-process'` arm-state rows (migration 1046),\n        // which nothing fires; this reconciler is what makes those rows mean something. It runs\n        // AFTER the unconditional arm above on purpose — no database read is on the boot path, and\n        // every failure inside it is fail-open (a sweep stays armed).\n        if (!utilityHostEnabled()) {\n          try {\n            const { startInProcessSweepArmReconciler, productionSweepArmDeps } = await import(\n              '@papercusp/operator-core/lib/dbos/in-process-sweep-arm'\n            );\n            startInProcessSweepArmReconciler(\n              productionSweepArmDeps({\n                eligible: inProcessPeriodicEligibleChecks,\n                armed: inProcessPeriodicArmedNames,\n                apply: applyInProcessSweepArmState,\n              }),\n            );\n          } catch (err) {\n            console.warn(\n              '[in-process-sweep-arm] reconciler arm failed (non-fatal — every sweep stays armed):',\n              err instanceof Error ? err.message : err,\n            );\n          }\n        }\n\n        // Ephemeral blueprint cadence tier (schedule-inventory-and-ephemeral-tier-2026-06-26 P-012 / D-006):\n        // arm each ACTIVE ephemeral routine as an in-process managed timer. Single-owner: the same\n        // backgroundWorkers gate as the sweeps above, AND never on a utility host (the request/util\n        // tier owns no schedules). Non-fatal — a query/arm failure must not block boot.\n        if (!utilityHostEnabled()) {\n          try {\n            const {\n              armEphemeralExecutor,\n              productionEphemeralExecutorDeps,\n              startEphemeralRoutineInvalidationSync,\n            } = await import(\n              '@papercusp/operator-core/lib/dbos/ephemeral-executor'\n            );\n            await armEphemeralExecutor(productionEphemeralExecutorDeps());\n            await startEphemeralRoutineInvalidationSync();\n          } catch (err) {"
        }
      ]
    },
    {
      "path": "patches/@dbos-inc+dbos-sdk+4.27.6.patch",
      "sha256": "41ca74025c3f7ae317b1dfcb62c8e50b15697d11648319ed3017aa4cacdacb31",
      "sourcePlane": "canonical-working-tree",
      "windows": [
        {
          "start": 1,
          "end": 17,
          "text": "diff --git a/node_modules/@dbos-inc/dbos-sdk/dist/src/debugpoint.js b/node_modules/@dbos-inc/dbos-sdk/dist/src/debugpoint.js\nindex 9ad1c4d..1d2c7ee 100644\n--- a/node_modules/@dbos-inc/dbos-sdk/dist/src/debugpoint.js\n+++ b/node_modules/@dbos-inc/dbos-sdk/dist/src/debugpoint.js\n@@ -29,8 +29,11 @@ exports.DebugAction = DebugAction;\n exports.pointTriggers = new Map();\n exports.pointLocations = new Map();\n async function debugTriggerPoint(name) {\n-    const cpi = getCallSiteInfo();\n+    // papercusp patch (WI-10002541): capture the call site only the FIRST time a\n+    // point is hit. It is only stored when absent, and a `new Error()` stack\n+    // capture + split + regex on every call ran in the queue-poll and step loops.\n     if (!exports.pointLocations.has(name)) {\n+        const cpi = getCallSiteInfo();\n         exports.pointLocations.set(name, { name, ...cpi, hitCount: 0 });\n     }\n     if (exports.pointTriggers.has(name)) {"
        }
      ]
    }
  ],
  "inProcessPopulation": {
    "writer": "buildDefaultChecks",
    "members": [
      {
        "id": "dbos-history-ceiling",
        "variable": "dbosHistoryCeilingCheck",
        "line": 146,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "system-health",
        "variable": "systemHealthCheck",
        "line": 173,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "harness-status-sweep",
        "variable": "harnessStatusSweepCheck",
        "line": 213,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "connection-pressure",
        "variable": "connectionPressureCheck",
        "line": 234,
        "scope": "process",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "pg-tuning-drift",
        "variable": "pgTuningDriftCheck",
        "line": 289,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "kernel-leak-watchdog",
        "variable": "kernelLeakCheck",
        "line": 314,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "host-contention-sampler",
        "variable": "hostContentionSamplerCheck",
        "line": 333,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "service-health",
        "variable": "serviceHealthCheck",
        "line": 348,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "completion-ref-verify",
        "variable": "completionRefVerifyCheck",
        "line": 362,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "spawn-reclaim-sweep",
        "variable": "spawnReclaimSweepCheck",
        "line": 376,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "stale-claim-sweep",
        "variable": "staleClaimSweepCheck",
        "line": 561,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "release-request-sweep",
        "variable": "releaseRequestSweepCheck",
        "line": 1032,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "learning-infra-health",
        "variable": "learningInfraHealthCheck",
        "line": 1302,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "steering-churn-sweep",
        "variable": "steeringChurnSweepCheck",
        "line": 1322,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "federation-drain-reconcile",
        "variable": "federationDrainReconcileCheck",
        "line": 1353,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "pot-epoch-key-reconcile",
        "variable": "hiveEpochKeyReconcileCheck",
        "line": 1377,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "shared-presence-reaper",
        "variable": "sharedPresenceReaperCheck",
        "line": 1405,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "scorecard-emission-pulse",
        "variable": "scorecardEmissionPulseCheck",
        "line": 1441,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "poll-suspect-scan",
        "variable": "pollSuspectScanCheck",
        "line": 1472,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      },
      {
        "id": "timer-registration-scan",
        "variable": "timerRegistrationScanCheck",
        "line": 1499,
        "scope": "host-default",
        "effectSpecificFence": "untraced-tick-descendant",
        "sourceRef": "packages/operator-core/lib/dbos/in-process-periodic.ts"
      }
    ],
    "completeForThisWriter": true,
    "notGlobalPopulation": true
  },
  "dependencyContract": {
    "lockEntry": {
      "version": "4.27.6",
      "resolved": "https://registry.npmjs.org/@dbos-inc/dbos-sdk/-/dbos-sdk-4.27.6.tgz",
      "integrity": "sha512-mr5CEllYovAHPh/TpQcvxTYM+4t4tgV7CjkZGe7hzNxw9Nzf6l7ggxJKDbewLFwgwx8NaWcWw21ESHXNE1UwrA==",
      "license": "MIT",
      "workspaces": [
        "packages/*"
      ],
      "dependencies": {
        "commander": "^12.0.0",
        "pg": "^8.11.3",
        "serialize-error": "^8.1.0",
        "superjson": "^1.13.3",
        "ws": "^8.18.1",
        "yaml": "^2.8.3"
      },
      "bin": {
        "dbos": "dist/src/cli/cli.js",
        "dbos-sdk": "dist/src/cli/cli.js"
      },
      "engines": {
        "node": ">=20"
      }
    },
    "installedPackageVersion": "4.27.6",
    "patchSha256": "41ca74025c3f7ae317b1dfcb62c8e50b15697d11648319ed3017aa4cacdacb31",
    "installedSdkMatchesLockTarball": "unmeasured",
    "candidateByteIdentity": "unmeasured"
  },
  "parentEvidence": [
    "runtime-migration/p001-global-background-ownership-source-501c.json",
    "runtime-migration/p001-nested-entrypoint-effects-501c.json"
  ],
  "findings": [
    {
      "id": "EPHEMERAL-DISPATCH",
      "source": "ephemeral-executor.ts:98-139,281-355; routines-runtime.ts:127-179",
      "ownership": "armed Map and scheduled-registry guard are process/realm local",
      "persistedState": "harness_shared.routines tier=ephemeral/active and metadata/last_fired_at",
      "effect": "fire resolves action and calls it within workspace ALS; recordFire updates by id after effect; no receipt claim or fencing token is passed by this dispatcher",
      "limit": "Action descendants may implement their own fencing; that is untraced here. No mixed-runtime production action proof."
    },
    {
      "id": "SWEEP-ARM",
      "source": "in-process-sweep-arm.ts:94-158,184-209; in-process-periodic.ts:1603-1624",
      "ownership": "cluster-primary filter for host scope, process scope for connection-pressure; code arm happens before durable enablement reconciliation",
      "persistedState": "harness_shared.routines tier=in-process arm state; ANY background workspace active=false disables; seed preserves active",
      "effect": "read failure leaves timers armed; this is an enablement switch, not a cross-process lease",
      "limit": "Tick-descendant fencing remains unresolved for each finite member."
    },
    {
      "id": "REGISTRY-LOCAL",
      "source": "scheduled-registry/src/index.ts:315-342,394-427,548-562; module-singleton/src/index.ts:82-123",
      "ownership": "Symbol.for/globalThis shared Map within one realm; singleton timer key replaces same-name registration; rec.running prevents local overlap",
      "persistedState": "none in registry state",
      "effect": "No interprocess persistence in the inspected timer registry; does not establish cross-host exclusion",
      "limit": "No assertion about all effect implementations elsewhere."
    },
    {
      "id": "DBOS-CLAIM",
      "source": "installed dbos-sdk system_database.js:2420-2441,2514-2584",
      "ownership": "workflow-row transaction; application/queue/version/partition scoped; row locks and UPDATE guarded ENQUEUED then RETURNING actual flips",
      "persistedState": "dbos.workflow_status including executor_id,application_version,application_name,recovery_attempts,deadline",
      "effect": "Queue admission is distinct from ownership of all background effects; not an external side-effect fence",
      "limit": "Installed SDK bytes are observed and hashed, but not proven equal to lock tarball plus committed patch or candidate. No DBOS Node/Bun result."
    },
    {
      "id": "DBOS-RECOVERY",
      "source": "installed dbos-executor.js:150-158,859-875; system_database.js:910-941; bootstrap.ts:289-333,523-562",
      "ownership": "recovery targets executor identity/application/version and re-enqueues PENDING rows; launch coalescing is local G singleton",
      "persistedState": "dbos.workflow_status; explicit SDK shutdown before retry after transient launch failure",
      "effect": "Recovered work returns through queue admission",
      "limit": "Stale executor external-effect fencing, duplicate executor identity, actual delivery and crash takeover unmeasured."
    },
    {
      "id": "GRACEFUL-MARKER",
      "source": "graceful-shutdown-recovery-credit.ts:69-105,225-270",
      "ownership": "executorId+pid+schema+timestamp marker validation, local file consumed before credit",
      "persistedState": "papercuspHome/run/dbos-graceful-shutdown-<sanitized executor>.json and dbos.workflow_status recovery_attempts for PENDING deadline-bounded rows",
      "effect": "Credit decrement before DBOS launch; crash without valid marker retains recovery charge",
      "limit": "Source only; process death/filesystem durability/candidate rollback not exercised."
    }
  ],
  "unresolved": [
    "Effect-specific descendant fencing for every inProcessPopulation member",
    "Installed DBOS SDK byte identity against lock tarball and committed patches before interpreting installed-source claims as candidate evidence",
    "Finite persistent-store/migration/source-loading guard and configured package/shell descendant census",
    "Actual immutable candidate Node/Bun DBOS delivery, global exclusive ownership/crash takeover, provider behavior, platform acceptance and rollback",
    "Node active; migration unshipped; terminal gateway EI-26759744278831998 remains untouched."
  ],
  "testsRun": [],
  "productFilesChanged": [],
  "relatedExistingIssue": "EI-26763668006363345"
}

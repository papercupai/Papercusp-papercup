---
rel_path: "runtime-migration/p001-global-background-ownership-source-501c.json"
updated_at: 1792749381121
_body: "content"
---

{
  "schema": "papercusp-global-background-ownership-source-census-v1",
  "workItem": "WI-6554700010022067",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "planItem": "P-001",
  "sourceOnly": true,
  "closureAccepted": false,
  "observedAt": "2026-10-23T09:56:21.077Z",
  "commitObserved": "026e8fbaa4bbcfb04745c15a0e9efe5ef8ddfa92",
  "sourceSelection": "canonical working-tree source; candidate/commit-byte identity not established by this artifact",
  "parentEvidence": [
    "runtime-migration/p001-nested-entrypoint-effects-501c.json",
    "runtime-migration/p001-configured-root-authority-ledger-501c.json"
  ],
  "sourceHashes": {
    "packages/operator-core/lib/background-workers.ts": "6f44bb5794a88fa60af6e6041e0cb96543bc551b17289be567599c4c7a644735",
    "apps/operator/bin/host-bootstrap.ts": "ec212f18b6c4d9f5eff93b7726698cc781dde06e22613accbd6d6a93cd74e28c",
    "packages/operator-core/lib/dbos/bootstrap.ts": "5e6b2d22cb5b25effe96c2e052940356bb094e46b55c51c90653544a732b2e52",
    "packages/operator-core/lib/system-health/single-primary-check.ts": "f635349119c8dbcaf30c1a823fe80110fedb74834f9ec8e1a898784d1a785835",
    "apps/operator/scripts/systemd/papercup-bg-host.service.d/95-bundled-entry.conf": "3a30461c04c0abcf35f4be7a1dfeedf331e22106e4f93e5f54ebed4915e4bf54"
  },
  "findings": [
    {
      "id": "BG-ROLE",
      "classification": "process-role-selector",
      "source": "backgroundWorkersEnabled/isHostSingleton/isSubstrateOwnerProcess",
      "observation": "Background role is selected through env and cluster.isPrimary. These predicates contain no cross-host lease acquisition; that limited predicate observation does not prove absence of lease mechanisms elsewhere."
    },
    {
      "id": "DBOS-BOOT",
      "classification": "durable-runtime-startup",
      "source": "host-bootstrap.ts/startDbos",
      "observation": "Host boot dynamically starts DBOS when backgroundWorkers and PAPERCUSP_DBOS_ENABLE=1; DBOS config uses schema dbos/applicationVersion PINNED_APP_VERSION. Port3170 without explicit DBOS__APPVERSION throws. DBOS delivery/claim/recovery under Node+Bun remains unmeasured."
    },
    {
      "id": "EPHEMERAL-BOOT",
      "classification": "in-process-schedule-startup",
      "source": "host-bootstrap.ts:2421",
      "observation": "Ephemeral timers arm under outer backgroundWorkers and !utilityHost branch. Actual per-routine claim/lease mechanisms remain distinct from global runtime ownership."
    },
    {
      "id": "DUPLICATE-DETECTOR",
      "classification": "detective-control",
      "source": "single-primary-check.ts:1",
      "observation": "Module contract describes a sustained duplicate/absent executor detector using PG application_name counts and escalation. It is not evidence of an exclusive global background lease."
    }
  ],
  "evidence": [
    {
      "path": "packages/operator-core/lib/background-workers.ts",
      "offset": 18,
      "limit": 7,
      "source": " */\nexport function backgroundWorkersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {\n  if (env.VITEST) return false;\n  return env.PAPERCUSP_BACKGROUND_WORKERS != null\n    ? env.PAPERCUSP_BACKGROUND_WORKERS !== '0'\n    : env.PAPERCUSP_HONO_PORT !== '3170';\n}\n"
    },
    {
      "path": "packages/operator-core/lib/background-workers.ts",
      "offset": 47,
      "limit": 5,
      "source": "export function isHostSingleton(opts?: { isPrimary?: boolean; env?: NodeJS.ProcessEnv }): boolean {\n  const isPrimary = opts?.isPrimary ?? nodeCluster.isPrimary;\n  return isPrimary && backgroundWorkersEnabled(opts?.env ?? process.env);\n}\n\n"
    },
    {
      "path": "packages/operator-core/lib/background-workers.ts",
      "offset": 178,
      "limit": 8,
      "source": "  isPrimary?: boolean;\n  env?: NodeJS.ProcessEnv;\n}): boolean {\n  const isPrimary = opts?.isPrimary ?? nodeCluster.isPrimary;\n  return isPrimary && !requestOnlyHost(opts?.env ?? process.env);\n}\n\n/**\n"
    },
    {
      "path": "apps/operator/bin/host-bootstrap.ts",
      "offset": 444,
      "limit": 11,
      "source": "  // Request-only hosts serve the HTTP/tool plane but do not own the host-wide\n  // warmers, voice transports, or credential refreshers. Keep this predicate\n  // separate from backgroundWorkersEnabled(): requestOnlyHost() is a pure\n  // topology check with no VITEST short-circuit, so it remains correct for\n  // explicit secondary hosts and for source-level boot guards.\n  const requestOnly = requestOnlyHost();\n  const utilityHost = utilityHostEnabled();\n  const backgroundWorkers = backgroundWorkersEnabled();\n  const backgroundSpawnerSidecarEnabled =\n    backgroundWorkers &&\n    !utilityHost &&\n"
    },
    {
      "path": "apps/operator/bin/host-bootstrap.ts",
      "offset": 2195,
      "limit": 24,
      "source": "  // and periodic-timer (PAPERCUSP_DBOS_TIMERS) workflows; the legacy setInterval\n  // workers stand down via their own guards.\n  if (backgroundWorkers && process.env.PAPERCUSP_DBOS_ENABLE === '1') {\n    void (async () => {\n      try {\n        // A stale/partially refreshed bundle can otherwise fail only while DBOS imports\n        // its routines graph, leaving the process alive with every scheduled routine dark.\n        // Check the bundled module namespace before startDbos() so the existing boot-failure\n        // attention + severe-event path reports the precise contract and rebuild action.\n        if (isBundledSidecar()) {\n          const workItems = await import('@papercusp/operator-core/lib/work-items');\n          assertDbosWorkItemsImportContract(workItems);\n          console.log('[dbos] bundled work-items import contract passed');\n        }\n        const { startDbos } = await import('@papercusp/operator-core/lib/dbos/bootstrap');\n        await startDbos();\n      } catch (err) {\n        const msg = err instanceof Error ? err.message : String(err);\n        console.warn('[dbos] boot failed (non-fatal):', msg);\n        // WI-4015/WI-4023: this catch used to be silent beyond the console.warn above —\n        // the process stays alive and LOOKS healthy while DBOS.launch() aborted partway\n        // through registration, so routinesTick never arms and every routine (git-sync,\n        // cross-hive-outbox-drain, scout-cycle, ...) goes dark with zero active paging.\n        // The request-path infra-liveness/single-primary detectors DO catch this\n"
    },
    {
      "path": "apps/operator/bin/host-bootstrap.ts",
      "offset": 2421,
      "limit": 16,
      "source": "        // Ephemeral blueprint cadence tier (schedule-inventory-and-ephemeral-tier-2026-06-26 P-012 / D-006):\n        // arm each ACTIVE ephemeral routine as an in-process managed timer. Single-owner: the same\n        // backgroundWorkers gate as the sweeps above, AND never on a utility host (the request/util\n        // tier owns no schedules). Non-fatal — a query/arm failure must not block boot.\n        if (!utilityHostEnabled()) {\n          try {\n            const {\n              armEphemeralExecutor,\n              productionEphemeralExecutorDeps,\n              startEphemeralRoutineInvalidationSync,\n            } = await import(\n              '@papercusp/operator-core/lib/dbos/ephemeral-executor'\n            );\n            await armEphemeralExecutor(productionEphemeralExecutorDeps());\n            await startEphemeralRoutineInvalidationSync();\n          } catch (err) {\n"
    },
    {
      "path": "packages/operator-core/lib/dbos/bootstrap.ts",
      "offset": 193,
      "limit": 15,
      "source": "export function assertSafeDbosAppVersionPartition(env: NodeJS.ProcessEnv = process.env): void {\n  const isStagingPort = env.PAPERCUSP_HONO_PORT === '3170';\n  const hasExplicitAppVersion = !!env.DBOS__APPVERSION;\n  if (isStagingPort && !hasExplicitAppVersion) {\n    const pinned = env.DBOS__APPVERSION || 'papercusp-jobs-v1';\n    throw new Error(\n      '[dbos] refusing to launch on PAPERCUSP_HONO_PORT=3170 (the staging host) with ' +\n        'PAPERCUSP_DBOS_ENABLE=1 and no explicit DBOS__APPVERSION override — the default ' +\n        `pinned applicationVersion (\"${pinned}\") is SHARED with the primary DBOS host, so this ` +\n        'process would steal + fail its queued scheduled fires (routinesTick/git-sync, ' +\n        'completionRefVerify, ...) instead of running its own (EI-90, the 2026-06-08 DBOS ' +\n        'appVersion war). Set a distinct DBOS__APPVERSION (and DBOS__VMID for recovery ' +\n        'isolation) before arming DBOS on this host — see bg-host.service for the pattern.',\n    );\n  }\n"
    },
    {
      "path": "packages/operator-core/lib/dbos/bootstrap.ts",
      "offset": 314,
      "limit": 13,
      "source": "  const { DBOS } = await import('@dbos-inc/dbos-sdk');\n  DBOS.setConfig({\n    name: 'papercusp-operator',\n    // Reuse the host's standard provider; DBOS preserves context across durable steps.\n    tracingEnabled: true,\n    systemDatabaseUrl: withDbosIdleTxGrace(url),\n    systemDatabaseSchemaName: 'dbos',\n    applicationVersion: PINNED_APP_VERSION,\n    // The operator shares a box with Restart (shop-api binds :3001); DBOS's\n    // admin server defaults to :3001 and would EADDRINUSE. We don't use it.\n    runAdminServer: false,\n  });\n\n"
    },
    {
      "path": "packages/operator-core/lib/system-health/single-primary-check.ts",
      "offset": 1,
      "limit": 19,
      "source": "/**\n * single-primary-check — the \"exactly one background primary\" guard\n * (infra-self-healing-supervision-2026-06-19, R4-2).\n *\n * The background machinery (DBOS routines / git-sync / substrate / the Queen\n * wake-loop) must run on EXACTLY ONE process. Two opposite failures both stem from\n * there being no enforcement:\n *   • 0 primaries — the silent routine-engine death (the BACKGROUND_WORKERS=0\n *     regression / bg-host down: routines, git-sync, Queen all stop, no alarm); and\n *   • >1 primaries — the documented catastrophe (bg-workers on two hosts vs one DB\n *     → DBOS appVersion war, a 102 GB substrate_outbox, plans rewritten 100k×).\n *\n * Each live DBOS executor holds PG connections tagged `dbos_transact_<vmid>_<appver>`\n * (observed in pg_stat_activity); a dead executor's connections are gone. So the\n * count of DISTINCT such application_names = the live background-primary count. This\n * guard runs on a :3070 REQUEST worker (independent of the primary it counts) and on\n * a sustained !=1 escalates to the owner — the request-path enforcement the plan's\n * D-001 calls for (\"the watcher must not live in what it watches\").\n *\n"
    }
  ],
  "unresolved": [
    "Trace actual existing cross-process/background effect-specific lease writers and fencing/release paths; do not invent a lease from detector/role names.",
    "Complete remaining configured shell/package descendant graph and persistence/migration/source-loading guard populations.",
    "Establish exact candidate/committed source identity and mixed-interpreter exclusivity/crash takeover before background cutover.",
    "Immutable candidate/platform/DBOS/provider/rollback/final shipment evidence remains outstanding."
  ],
  "notDone": [
    "No product edits or tests this continuation.",
    "Node remains active; Bun background ownership not accepted.",
    "Terminal EI-26759744278831998 must not be reworked."
  ]
}

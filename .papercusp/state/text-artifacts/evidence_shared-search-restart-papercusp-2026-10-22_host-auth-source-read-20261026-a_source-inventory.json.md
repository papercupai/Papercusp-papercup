---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/host-auth-source-read-20261026-a/source-inventory.json"
updated_at: 1793046334642
_body: "content"
---

{
  "schemaVersion": "p001-host-auth-source-read-v1",
  "observedAt": "2026-10-26T20:24:50.233085+00:00",
  "workItem": "WI-6554700010022135",
  "plan": "shared-search-restart-papercusp-2026-10-22",
  "item": "P-001",
  "kind": "read-only-source-inventory",
  "executed": false,
  "testsRun": [],
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "branch": "staging",
  "headAtCapture": "8361237bd65531b14a1ffdb2d413d25c6d065b9d",
  "sourcePins": [
    {
      "path": "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts",
      "sha256": "0c31d2c6882743864c3efa9aaa2ae57d7d24d88ae0151b2ff4d219819d899ec2",
      "matchesEarlierReadPin": true,
      "excerpts": [
        {
          "firstLine": 1706,
          "lastLine": 1715,
          "text": "  // ── (1) Superuser ───────────────────────────────────────────────\n  if (url.searchParams.get('superuser') === '1') {\n    const headers = headersFromExtra(extra);\n    if (!isLoopbackRequest(headers)) return { kind: 'failed', reason: 'superuser_non_loopback' };\n    const bearer = bearerFromExtra(extra);\n    if (!isValidSuperuserBearer(bearer)) return { kind: 'failed', reason: 'superuser_invalid_bearer' };\n    const wsParam = (url.searchParams.get('workspace') ?? '').trim();\n    const headerWs = (headers.get('x-papercusp-workspace') ?? '').trim();\n    const harnessUrlParam = (url.searchParams.get('harness') ?? '').trim();\n    const clientParam = (url.searchParams.get('client') ?? '').trim();"
        },
        {
          "firstLine": 2094,
          "lastLine": 2157,
          "text": "      return { kind: 'failed', reason: 'connected_app_workspace_mismatch' };\n    }\n    const clientParam = (url.searchParams.get('client') ?? '').trim();\n    return {\n      kind: 'ok',\n      ctx: {\n        workspaceId: principal.workspaceId,\n        ...(dataPlaneDegradedAtMs ? { dataPlaneDegradedAtMs } : {}),\n        harnessSlug: '*',\n        role: 'papercup' as AgentRole,\n        featureId: null,\n        chunkId: null,\n        runId: globalThis.crypto.randomUUID(),\n        spawnId: principal.slug,\n        parentSpawnId: null,\n        uiClientId: clientParam || null,\n        detectorSessionKey: null,\n        planRunSessionId,\n        profile: 'engineer',\n        requestOrigin,\n        authenticatedPrincipal: principal,\n      },\n    };\n  }\n\n  // ── (1a) Public Papercup PI principal ────────────────────────────\n  // `workspace=` used to enter the signed-spawn parser before bearer auth, so\n  // strict mode rejected this mount as an unsigned spawn. Authenticate the\n  // short-lived PI bearer first and derive its workspace; its own capabilities\n  // remain the dispatch gate.\n  if (url.searchParams.get('principal') === 'pi') {\n    const forbidden = ['role', 'spawn', 'harness', 'sig', 'exp', 'superuser', 'power_user'].find((key) =>\n      url.searchParams.has(key),\n    );\n    if (forbidden) return { kind: 'failed', reason: `pi_principal_forbidden_param:${forbidden}` };\n    const principal = await resolveBearer(bearerFromExtra(extra));\n    if (!principal) return { kind: 'failed', reason: 'pi_principal_invalid_bearer' };\n    if (principal.kind !== 'pi') return { kind: 'failed', reason: 'pi_principal_wrong_kind' };\n    const requestedWorkspace = (url.searchParams.get('workspace') ?? '').trim();\n    if (!requestedWorkspace || requestedWorkspace !== principal.workspaceId) {\n      return { kind: 'failed', reason: 'pi_principal_workspace_mismatch' };\n    }\n    const clientParam = (url.searchParams.get('client') ?? '').trim();\n    return {\n      kind: 'ok',\n      ctx: {\n        workspaceId: principal.workspaceId,\n        ...(dataPlaneDegradedAtMs ? { dataPlaneDegradedAtMs } : {}),\n        harnessSlug: '*',\n        role: 'papercup' as AgentRole,\n        featureId: null,\n        chunkId: null,\n        runId: globalThis.crypto.randomUUID(),\n        spawnId: principal.slug,\n        parentSpawnId: null,\n        uiClientId: clientParam || null,\n        detectorSessionKey: null,\n        planRunSessionId,\n        profile: 'engineer',\n        requestOrigin,\n        authenticatedPrincipal: principal,\n        interactiveCardCapability: true,\n      },\n    };"
        },
        {
          "firstLine": 2164,
          "lastLine": 2177,
          "text": "  // docs/plans/omp-power-user-bundle-2026-05-20.md §4.1.\n  if (url.searchParams.get('power_user') === '1') {\n    const headers = headersFromExtra(extra);\n    if (!isLoopbackRequest(headers)) {\n      return { kind: 'failed', reason: 'power_user_non_loopback' };\n    }\n    const claims = await verifyAccessToken(bearerFromExtra(extra));\n    if (!claims) {\n      return { kind: 'failed', reason: 'power_user_invalid_token' };\n    }\n    const harnessParam = (url.searchParams.get('harness') ?? '').trim();\n    const clientParam = (url.searchParams.get('client') ?? '').trim();\n    // Same per-session source as the superuser path (highest precedence):\n    // an OMP power-user launch carries its PAPERCUSP_SID via the"
        },
        {
          "firstLine": 2242,
          "lastLine": 2259,
          "text": "  // anything — it's a probe / health check / pre-spawn discovery — so\n  // we shouldn't audit-log it as a sig-missing failure in strict mode.\n  // (Calling tools/list on it lists the catalog for a LOCAL caller only —\n  // an outside caller gets mcp_auth_failed, see resolveVisibleToolListings;\n  // tools/call falls through to the \"none\" path which rejects with\n  // invalid_request_context.)\n  const claimsSpawn =\n    url.searchParams.has('role') || url.searchParams.has('spawn') || url.searchParams.has('workspace');\n\n  let sigVerified = false;\n  let verifiedKeySha256: string | undefined;\n  if (hasSig || hasExp) {\n    const v = await verifySpawnParams(url, { includeKeyDigest: true });\n    if (!v.ok) {\n      const spawn = url.searchParams.get('spawn');\n      const role = url.searchParams.get('role');\n      const harness = url.searchParams.get('harness');\n      // WI-3190: classify a strand (a spawn this process previously authenticated,"
        },
        {
          "firstLine": 2305,
          "lastLine": 2355,
          "text": "      reason: 'missing_sig_required_mode',\n      claimedRole: url.searchParams.get('role'),\n      claimedHarness: url.searchParams.get('harness'),\n      claimedWorkspace: url.searchParams.get('workspace'),\n      claimedSpawn: url.searchParams.get('spawn'),\n      remoteAddr,\n      userAgent,\n    });\n    return {\n      kind: 'failed',\n      reason: `spawn_sig_missing_sig_required_mode — ${spawnSigFailureGuidance('missing_sig_required_mode')}`,\n    };\n  } else {\n    // Soft-warn period: allow unsigned URLs but log so we can see the\n    // transition progress.\n    if (url.searchParams.has('role') || url.searchParams.has('spawn')) {\n      console.warn(\n        '[spawn-signing] accepting UNSIGNED spawn URL (set PAPERCUSP_REQUIRE_SPAWN_SIG=1 to reject). ' +\n          `role=${url.searchParams.get('role')} harness=${url.searchParams.get('harness')} ` +\n          `spawn=${url.searchParams.get('spawn')}`,\n      );\n    }\n  }\n\n  try {\n    const parsed = parseRequestContext(url);\n    return {\n      kind: 'ok',\n      ctx: {\n        workspaceId: parsed.workspaceId,\n        ...(dataPlaneDegradedAtMs ? { dataPlaneDegradedAtMs } : {}),\n        harnessSlug: parsed.harnessSlug,\n        // Canonicalize pre-rename role spellings (bee→cup, queen→mug, sentinel→\n        // papercup, overwatch→kettle, scout→blender) here, at the one point every\n        // downstream gate (role-allowlist in dispatch-stack.ts, AND\n        // loadRoleCapabilities/synthesizeDispatchPrincipal below) reads `ctx.role`\n        // from. Without this, a caller whose spawn URL still carries an old-spelling\n        // `role=bee` gets a principal literally named `system:bee`, which has NO\n        // entry in BLUEPRINT_ROLE_CAPS (only the canonical `cup` key exists) — every\n        // capability-gated tool call 100%-fails with `missing_capability`, e.g.\n        // `capability:git` (EI-667), even though the canonical `cup` role already\n        // carries it. canonicalCoordRole is identity for an already-canonical role,\n        // so this is a no-op for every current spawn.\n        role: canonicalCoordRole(parsed.role) as AgentRole,\n        featureId: parsed.featureId,\n        chunkId: parsed.chunkId,\n        runId: parsed.runId,\n        spawnId: parsed.spawnId,\n        parentSpawnId: parsed.parentSpawnId,\n        uiClientId: parsed.uiClientId,\n        detectorSessionKey: parsed.detectorSessionKey,"
        },
        {
          "firstLine": 2491,
          "lastLine": 2503,
          "text": "  // unaffected (they ignore ctx.tx).\n  if (tool.crossWorkspace === true) {\n    const { sql: adminTx } = getOrgPg();\n    const ctx: UnifiedToolContext = {\n      ...baseCtx,\n      tx: adminTx,\n      principal: await synthesizeDispatchPrincipal(adminTx, spawnCtx),\n    };\n    return runWithWorkspaceIfConcrete(spawnCtx.workspaceId, () => run(ctx));\n  }\n  // EI-20226130855047135: role-gated tools explicitly declare that their\n  // handlers do not require a principal. A superuser/power-user already has\n  // the capability bypass needed by the dispatch stack, and a tool that also"
        },
        {
          "firstLine": 3111,
          "lastLine": 3125,
          "text": "    workspaceId: spawn.workspaceId,\n    harnessSlug: spawn.harnessSlug,\n    // No-tx tools still need a principal-shaped provenance stamp for\n    // tool_invocations. Transaction-backed dispatch replaces this lightweight\n    // value with the capability-enriched principal below.\n    principal: synthesizeTransportPrincipal(spawn),\n    projectDir: paths.projectDir,\n    stateDir: paths.stateDir,\n    role: spawn.role,\n    featureId: spawn.featureId,\n    chunkId: spawn.chunkId,\n    runId: spawn.runId,\n    chatParent: spawn.chatParent,\n    spawnId: spawn.spawnId,\n    parentSpawnId: spawn.parentSpawnId,"
        },
        {
          "firstLine": 3910,
          "lastLine": 3917,
          "text": " * before any admission replay and binds the current native session context. */\nconst NATIVE_TOOL_OWNER_UNSUPPORTED_CAPABILITY = 'native_tool_owner_unsupported_capability';\n\nexport function normalizeNativeMcpOwnerSpawn(spawn: BuiltSpawnContext): BuiltSpawnContext {\n  if (spawn.authenticatedPrincipal) throw new Error(NATIVE_TOOL_OWNER_UNSUPPORTED_CAPABILITY);\n  const authority = spawn.admissionRecoveryAuthority;\n  if (authority === undefined) return spawn;\n  const parsed = admissionAuthoritySchema.safeParse(authority);"
        },
        {
          "firstLine": 6480,
          "lastLine": 6493,
          "text": "              if (spawnRes.kind !== 'ok') return null;\n\n              const userStartedAt = Date.now();\n              const user = await getSessionUserOrDefault().finally(() => {\n                stages.userLookupMs = Date.now() - userStartedAt;\n              });\n              const ctxWorkspace = spawnRes.ctx.workspaceId;\n              const ctxHarness = spawnRes.ctx.harnessSlug;\n              const preludeStartedAt = Date.now();\n              const prelude = await buildMcpPrelude({\n                userId: user.id,\n                workspaceId: ctxWorkspace && ctxWorkspace !== '*' ? ctxWorkspace : activeWorkspaceId(),\n                url: urlFromExtra(extra),\n                // WI-4393: ctx.harnessSlug already resolved header (OMP)-vs-URL-param"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/routes/transport/mcp-auth-challenge.ts",
      "sha256": "ca99e75c4bf6f596bb52510bff0eb06b0977aaf911bff6e47082d5978c97fed6",
      "matchesEarlierReadPin": true,
      "excerpts": [
        {
          "firstLine": 64,
          "lastLine": 83,
          "text": "    let verdict: { ok: boolean; reason?: string };\n    try {\n      verdict = await deps.verifyAppKey(token);\n    } catch {\n      return null;\n    }\n    if (verdict.ok) return null;\n    const code = appKeyRefusalCode(verdict.reason);\n    return challenge(req, 'invalid_token', `the access token is not valid (${code})`, code);\n  }\n  if (token !== null) return null;\n  if (new URL(req.url).searchParams.has('sig')) return null;\n  if (deps.isLocal(req.headers)) return null;\n  return challenge(req, null, 'sign in to use this workspace');\n}"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/routes/transport/role-principal-caps.ts",
      "sha256": "ddf02bc62b1ec4a2b413140b6c391a163649842f930ac75358ddeef80f2c5400",
      "matchesEarlierReadPin": true,
      "excerpts": [
        {
          "firstLine": 562,
          "lastLine": 581,
          "text": "  workspaceId: string;\n  role: string;\n  isSuperuser?: boolean;\n  authenticatedPrincipal?: Principal;\n  /** Explicitly false only for an accepted unsigned legacy spawn URL. */\n  sigVerifiedSpawn?: boolean;\n}): Principal | null {\n  if (spawnCtx.authenticatedPrincipal) return spawnCtx.authenticatedPrincipal;\n  if (!spawnCtx.workspaceId || spawnCtx.workspaceId === '*') return null;\n  const isSuperuser = spawnCtx.isSuperuser === true;\n  const unsignedLegacy = !isSuperuser && spawnCtx.sigVerifiedSpawn === false;\n  return {\n    kind: isSuperuser ? 'system' : unsignedLegacy ? 'loopback' : 'harness',\n    slug: isSuperuser ? 'system:operator' : `system:${spawnCtx.role}`,\n    workspaceId: spawnCtx.workspaceId,\n    authMethod: isSuperuser ? 'bearer-token' : unsignedLegacy ? 'host-loopback' : 'spawn-url',\n    trust: isSuperuser || !unsignedLegacy ? 'trusted' : 'unverified-loopback',\n    capabilities: new Set<string>(),\n  };\n}"
        },
        {
          "firstLine": 667,
          "lastLine": 704,
          "text": "export async function synthesizeDispatchPrincipal(\n  tx: Sql,\n  spawnCtx: {\n    workspaceId: string;\n    role: string;\n    /** The caller's harness (BuiltSpawnContext carries it); see loadRoleCapabilities. */\n    harnessSlug?: string;\n    isSuperuser?: boolean;\n    authenticatedPrincipal?: Principal;\n    /** Explicitly false only for an accepted unsigned legacy spawn URL. */\n    sigVerifiedSpawn?: boolean;\n  },\n): Promise<Principal> {\n  if (spawnCtx.authenticatedPrincipal) return spawnCtx.authenticatedPrincipal;\n  const capabilities = spawnCtx.isSuperuser\n    ? new Set<string>()\n    : await loadRoleCapabilities(tx, spawnCtx.workspaceId, spawnCtx.role, spawnCtx.harnessSlug);\n  // Keep the legacy capability/role behavior above, but carry the transport's\n  // resolved provenance into telemetry. `sigVerifiedSpawn` is supplied by the\n  // MCP adapter for URL calls; omitted by older nested-dispatch callers, which\n  // are already inside an authenticated dispatch and therefore retain the\n  // trusted spawn identity. Only an explicit false is the unsigned fallback.\n  const provenance: Pick<Principal, 'kind' | 'authMethod' | 'trust'> = spawnCtx.isSuperuser\n    ? { kind: 'system', authMethod: 'bearer-token', trust: 'trusted' }\n    : spawnCtx.sigVerifiedSpawn === false\n      ? { kind: 'loopback', authMethod: 'host-loopback', trust: 'unverified-loopback' }\n      : { kind: 'harness', authMethod: 'spawn-url', trust: 'trusted' };\n  return {\n    ...provenance,\n    slug: spawnCtx.isSuperuser ? 'system:operator' : `system:${spawnCtx.role}`,\n    workspaceId: spawnCtx.workspaceId,\n    capabilities,\n  };\n}"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/auth.ts",
      "sha256": "83536580499636fb25e83834095a9181323bdcc5e25000287028c76e18206d62",
      "matchesEarlierReadPin": true,
      "excerpts": [
        {
          "firstLine": 106,
          "lastLine": 121,
          "text": "export async function resolveSessionToken(headers?: Headers): Promise<string | undefined> {\n  if (headers) {\n    return parseCookieHeader(headers.get('cookie')).get(SESSION_COOKIE);\n  }\n  try {\n    // @vite-ignore: `next` is a PHANTOM package (no package.json declares it;\n    // absent from the lock) — present on long-lived dev boxes, absent on any\n    // clean install (cloud frames — found live 2026-06-06). Without the ignore,\n    // Rolldown fails the whole SPA build trying to resolve this fallback.\n    const { cookies } = await import(/* @vite-ignore */ 'next/headers');\n    const jar = await cookies();\n    return jar.get(SESSION_COOKIE)?.value;\n  } catch {\n    return undefined;\n  }\n}"
        },
        {
          "firstLine": 130,
          "lastLine": 135,
          "text": "export async function getSessionUser(headers?: Headers): Promise<SessionUser | null> {\n  const token = await resolveSessionToken(headers);\n  if (!token) return null;\n  // Do not acquire the database pool until the request actually presents a\n  // session cookie. Unauthenticated requests are expected to resolve to null\n  // without touching Postgres; besides preserving the cheap no-session path,"
        },
        {
          "firstLine": 190,
          "lastLine": 209,
          "text": " */\nexport async function getSessionUserOrDefault(headers?: Headers): Promise<User> {\n  const { sql } = getOrgPg();\n  const user = await getSessionUser(headers);\n  if (user) return user;\n  await ensureDefaultUser();\n  const rows = await sql<{ id: string; username: string; display_name: string; password_hash: string | null }[]>`\n    SELECT id, username, display_name, password_hash\n      FROM harness_shared.users\n     WHERE username = 'default'\n       AND is_active = true\n     LIMIT 1\n  `;\n  if (rows.length === 0) {\n    throw new Error('default user not present after ensureDefaultUser');\n  }\n  const r = rows[0];\n  return { id: r.id, username: r.username, display_name: r.display_name, has_password: r.password_hash !== null };\n}\n"
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/agent-tools/memory/search.ts",
      "sha256": "82e61cb6794055d1e3ee325ecb05d65228cef635117521e115cb9b77e0fe258e",
      "matchesEarlierReadPin": true,
      "excerpts": [
        {
          "firstLine": 204,
          "lastLine": 232,
          "text": "  async handler(args, ctx) {\n    const judgeScope = resolveJudgeMemorySearchScope(args, ctx);\n    if (judgeScope?.ok === false) {\n      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: judgeScope.reason, results: [] }) }] };\n    }\n    const searchHarnessSlug = judgeScope ? judgeScope.harnessSlug : args.harness_slug;\n    const searchHarnessOnly = judgeScope ? judgeScope.harnessOnly : args.harnessOnly;\n    const user = await getSessionUserOrDefault();\n    const backend = getMemoryBackend();\n    const limit = args.limit ?? 8;\n\n    // Scope resolution — registry/flag reads only, never a memory-backend\n    // call, so it sits AHEAD of the deadline-guarded region: the degraded\n    // lexical fallback below needs the SAME scopes after the semantic leg\n    // has already failed (WI-4214).\n    let harnessSlugs: string[];\n    if (searchHarnessSlug) {\n      harnessSlugs = [searchHarnessSlug];\n    } else {\n      try {\n        // The principal carries the resolved workspace (incl. a per-call\n        // `workspace` pin from an unscoped SU session); the old\n        // `ctx.workspaceId` read was never populated on principal-gated\n        // handlers, so the fan-out silently degraded to user-pool-only (P-004).\n        const reg = await loadHarnessRegistry(ctx.principal?.workspaceId ?? '');\n        // P-016: exclude ephemeral/benchmark harness scopes from unscoped\n        // production recall so benchmark memories don't pollute results.\n        // Explicit harness_slug (above) bypasses this filter intentionally.\n        harnessSlugs = reg.projects.map((p) => p.slug).filter((s) => !isEphemeralBenchmarkHarnessSlug(s));"
        },
        {
          "firstLine": 253,
          "lastLine": 260,
          "text": "    }\n\n    // Scope: user-pool + harness-pool(s) normally. With harnessOnly (+ a harness_slug), scope to ONLY the\n    // harness pool — drop the user pool — so an ISOLATED per-run pool (a benchmark capability-injection arm)\n    // recalls just its own facts, not the user's personal memories (which would be noise / confound the\n    // measurement). harnessOnly without harness_slug is meaningless (no pool to isolate to) → ignored.\n    const harnessScopes = harnessSlugs.map((slug) => `harness:${slug}`);\n    const scope = searchHarnessOnly && searchHarnessSlug ? harnessScopes : [user.id, ...harnessScopes];"
        },
        {
          "firstLine": 396,
          "lastLine": 402,
          "text": "    // data-scoping-audit P-006 / D-004 / D-012 (dark cutover): workspace-scope the USER\n    // pool — drop `project` hits tagged with a different workspace; keep owner-tier +\n    // legacy NULL-workspace. harness pools (scope `harness:*`) pass through untouched.\n    if (await isMemoryWorkspaceScopedRecallOn()) {\n      const activeWs = ctx.principal?.workspaceId;\n      hits = hits.filter((h) => h.scope !== user.id || keepUserPoolHitForWorkspace(h, activeWs));\n    }"
        }
      ]
    },
    {
      "path": "packages/agent-mcp/src/auth.ts",
      "sha256": "c0179829ab12d36347dba6400ea2c2ae7a04f9406ff7175a908c7d9b46301504",
      "matchesEarlierReadPin": true,
      "excerpts": [
        {
          "firstLine": 47,
          "lastLine": 53,
          "text": "\n/** Positive entries: revocation lag is bounded by this even if LISTEN is down. */\nconst CACHE_TTL_MS = 60_000;\n/** Negative entries (ended session / missing row / hash mismatch): short, so a\n *  just-provisioned principal racing a probe isn't blocked for long. */\nconst NEGATIVE_TTL_MS = 15_000;\n/** LRU bound — pi sessions accumulate one entry each (EI-79 contributor). */"
        },
        {
          "firstLine": 243,
          "lastLine": 268,
          "text": "export async function resolveBearer(bearer: string): Promise<Principal | null> {\n  if (!bearer) return null;\n\n  // bearer → token_index identity, served from a per-bearer-hash cache (the\n  // identity is immutable for a live token — see TOKEN_INDEX_CACHE). The hash is\n  // also the capability-load credential, so compute it once here.\n  const bh = bearerHash(bearer);\n  const identity = await resolveTokenIdentity(bearer, bh);\n  if (!identity) return null;\n  const { kind, slug, workspaceId } = identity;\n\n  ensureInvalidationListener();\n\n  // Cache check — negative entries (ended sessions etc.) are cached too, so a\n  // dead bearer hammering the server doesn't re-load capabilities every call.\n  const ck = cacheKey(workspaceId, slug);\n  const cached = lruGet(CACHE, ck);\n  if (cached) return cached.value;\n\n  const authz = await loadPrincipalAuthorization(workspaceId, kind, slug, bh);\n  if (!authz) {\n    lruSet(CACHE, ck, null);\n    return null;\n  }\n\n  // Bearer-token-resolved principals are 'trusted' — the bearer hash was"
        },
        {
          "firstLine": 318,
          "lastLine": 344,
          "text": "    const sessionId = slug.startsWith('pi:') ? slug.slice('pi:'.length) : slug;\n    const rows = await tx<Array<{\n      bearer_hash: string;\n      capabilities: unknown;\n      allowed_tools: unknown;\n      ended_at: Date | null;\n      expires_at: Date | string;\n    }>>`\n      SELECT bearer_hash, capabilities, allowed_tools, ended_at, expires_at\n        FROM harness_shared.pi_sessions\n       WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}\n         AND expires_at > now()\n       LIMIT 1\n    `;\n    if (!rows.length) return null;\n    if (rows[0].ended_at) return null;\n    if (rows[0].bearer_hash !== expectedHash) return null;\n    const expiresAtMs = new Date(rows[0].expires_at).getTime();\n    if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) return null;\n    return {\n      capabilities: setOf(rows[0].capabilities),\n      ...(rows[0].allowed_tools === null || rows[0].allowed_tools === undefined\n        ? {}\n        : { allowedTools: setOf(rows[0].allowed_tools) }),\n      expiresAtMs,\n    };\n  });"
        }
      ]
    },
    {
      "path": "libs/generic/tooldef/src/define-tool.ts",
      "sha256": "c32fcecd3e2cbc50bafae715b87a65e02c04b100646a1b9b7824a21a2a6e642f",
      "matchesEarlierReadPin": true,
      "excerpts": [
        {
          "firstLine": 3360,
          "lastLine": 3380,
          "text": "    // Preserve host context metadata without touching `tx`: transaction-free\n    // dispatches may install a fail-loud getter there. Copy descriptors first,\n    // then omit the three fields whose legacy contracts differ from the host.\n    const passthroughDescriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(ctx);\n    delete passthroughDescriptors.tx;\n    delete passthroughDescriptors.principal;\n    delete passthroughDescriptors.log;\n    const passthroughCtx = Object.defineProperties({}, passthroughDescriptors) as Omit<\n      UnifiedToolContext, 'tx' | 'principal' | 'log'\n    >;\n    const legacyCtx = {\n      ...passthroughCtx,\n      principal: ctx.principal as unknown as ToolContext['principal'],\n      // EI-18808330244321407: transaction-free tools receive no `tx` key at\n      // all. A declared consumer reaches this point only with a real bound tx.\n      ...(def.needsWorkspaceTx === true\n        ? { tx: workspaceTx as ToolContext['tx'] }\n        : {}),\n      log: (level, msg, meta) => ctx.log(`[${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),\n      // Thread the RESOLVED payload tier so principal-gated tools that keep a\n      // hand-rolled JSON ToolResult (byte-stable contracts — memory:search)"
        },
        {
          "firstLine": 3426,
          "lastLine": 3430,
          "text": "    // unrepresentable rather than leaving six sites each needing an `await` remembered.\n    const disclose = async (result: ToolResult | Promise<ToolResult>): Promise<ToolResult> =>\n      attachCorrectedDisclosure(await result, corrections);\n    const response = await def.handler(parsed.value, legacyCtx);\n    const explicitFullRequest = isExplicitFullPayloadRequest(callTier, ctx);"
        }
      ]
    },
    {
      "path": "libs/generic/tooldef-http/src/http-projection.ts",
      "sha256": "6f4aebeaa56ddd2fcbfe432fe9b0bd67d5537146f39d4ca5e2a9089fcde382ad",
      "matchesEarlierReadPin": true,
      "excerpts": [
        {
          "firstLine": 350,
          "lastLine": 361,
          "text": "  const ctx: UnifiedToolContext = {\n    log: (msg) => {\n      const fullCtx: UnifiedToolContext = { ...spawnCtx, log: () => {}, signal: abort.signal, progress: () => {}, emit: noopEmit };\n      extras.log?.(msg, fullCtx);\n    },\n    signal: abort.signal,\n    progress: (pct, msg) => {\n      const fullCtx: UnifiedToolContext = { ...spawnCtx, log: () => {}, signal: abort.signal, progress: () => {}, emit: noopEmit };\n      extras.progress?.(pct, msg, fullCtx);\n    },\n    emit: noopEmit,\n    transport: 'http',"
        },
        {
          "firstLine": 376,
          "lastLine": 389,
          "text": "    ...(extras.secret ? { secret: extras.secret } : {}),\n  };\n  const auth = req.headers['authorization'];\n  if (auth && extras.resolvePrincipalAndTx) {\n    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth;\n    try {\n      const resolved = await extras.resolvePrincipalAndTx(bearer);\n      if (resolved) {\n        ctx.principal = resolved.principal;\n        ctx.tx = resolved.tx;\n      }\n    } catch { /* continue anonymous */ }\n  }\n  return { ok: true, tool, ctx };"
        }
      ]
    }
  ],
  "limitations": [
    "Source inspection only; no new host/browser/cookie/spawn/PI execution or RLS/NOTIFY/TTL/epoch qualification.",
    "Default user and authenticated principal are distinct; no browser identity binding asserted.",
    "No source or runtime provenance promotion of native22254994 or original71348/22247225.",
    "Paid route remains paused; no extra implementers; no LIVE_GATE_OPS."
  ]
}

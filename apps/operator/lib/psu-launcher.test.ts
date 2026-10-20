import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { appendHostEvent, eventLogPathForOwner } from "../scripts/psu-pty-host.mjs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
  symlinkSync,
  lstatSync,
  realpathSync,
  readlinkSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PSU_REQUEST_TIMEOUT_MS } from "./mcp-proxy/budgets.mjs";
import { KICKOFF_PROMPT_FILE_ENV, prepareKickoffEnvironment } from "../../../packages/operator-core/lib/agent-kickoff/prompt-transport.mjs";
import { resolvePtoolOperatorBase } from "../scripts/ptool.mjs";
import {
  CODEX_SAFE_DEFAULT_MODEL,
  codexContextConfigArgs,
  codexContextConfigToml,
} from "../../../packages/operator-core/lib/model-context-budget.mjs";
import {
  parseArgs,
  codexOriginalRoutingFingerprint,
  assertOriginalCodexRouting,
  applyOriginalCodexRouting,
  consumeOriginalCodexRouting,
  ORIGINAL_CODEX_ROUTING_ENV,
  resolveNativeMcpAssets,
  nativeOmpExtensionArgs,
  pickRole,
  pickIdentity,
  identityPickerChoices,
  createLaunchOptionsReader,
  PSU_HELP_TEXT,
  planValue,
  parkRoleScopedMcpJson,
  ompDefaultModelAdvisory,
  ompDefaultModel,
  resolveOmpSessionModel,
  writeOmpSessionConfigDir,
  writeOmpSessionConfigDirAsync,
  linkOmpAgentDb,
  applyOmpToolsAllowlist,
  applyOmpOperatorOrigin,
  applyOmpOperatorBearer,
  applyOmpMcpUrlParams,
  resolveOmpOperatorUrl,
  probeOmpOperatorMcp,
  ompCoreToolNames,
  ompCompactToolNames,
  claudeSeedToolNames,
  claudeCompactToolNames,
  CLAUDE_SEED_EXTRA_TOOL_NAMES,
  CLAUDE_MINIMAL_SEED_TOOL_NAMES,
  isWeakOmpModel,
  bareOmpModelId,
  probeOmpBackendContextWindow,
  readModelsYmlContextWindow,
  rewriteModelsYmlContextWindow,
  rewriteModelsJsonContextWindow,
  readModelsYmlField,
  rewriteModelsYmlField,
  rewriteModelsJsonFields,
  computeMaxTurnTokens,
  computeOutputDoorTokens,
  computeCompactionThresholdPercents,
  OMP_CORE_MCP_TOOL_NAMES,
  selectionsFromArgs,
  presetsFromArgs,
  codexForkMcpUrlForOwner,
  resumeArgsFor,
  resumeEnvFor,
  contextTrimmingEnv,
  resumeAccountPlan,
  chooseResumeAccount,
  buildResumeEnv,
  addClaudeResumeToolReferencesToEnv,
  ompTrackedResumeEnv,
  applyOmpResumeAccountRoute,
  ompDirectModelForRoute,
  rehealResumeCredentials,
  rehealResumeCodexAuth,
  claudeCredExpiresAt,
  gatewayPinEnv,
  gatewayAutoEnv,
  codexAutoPoolVerdict,
  preflightCodexAutoPool,
  ALLOW_WALLED_LAUNCH_ENV,
  accountRoutingMode,
  codexGatewayConfigPatch,
  applyScopedNativeGateway,
  accountPinnable,
  accountPickerChoices,
  accountProviderFromChoices,
  GATEWAY_ACCOUNT_HEADER,
  GATEWAY_OWNER_HEADER,
  GATEWAY_CLIENT_AUTH_TOKEN,
  ACCOUNT_ROUTING_MODE_ENV,
  CLAUDE_DEFAULT_AUTH_ENV_KEYS,
  defaultAccountEnv,
  isCacheProxyUrl,
  cacheProxyReachable,
  __setCacheProxyReachable,
  CACHE_PROXY_URL,
  defaultClaudeAuthSettings,
  applyDefaultClaudeAuthSettingsArgs,
  enforceDefaultClaudeAccount,
  sanitizeInheritedEnv,
  applyCodexDiagnosticEnv,
  applyHeadlessCodexBrowserPolicy,
  CODEX_DIAGNOSTIC_RUST_LOG,
  addDirArgs,
  forkUnsupportedMessage,
  forkBootstrapBody,
  launchModeFromArgs,
  trackedForkEnvelopeEnv,
  forkFallbackAccountRoute,
  forkBootstrapFallbackMessage,
  launchTrackedFork,
  freshSuBootstrapBody,
  inheritFreshCodexConfiguredModel,
  launchesOnSuTier,
  suRoleFor,
  psuLaunchArgvRecord,
  resumeLaunchArgvRecord,
  effectiveAutoMode,
  assertFleetJoined,
  roleBootstrapBody,
  requestedRoleModelFromBootstrap,
  requireOmpRoleMcpJsonPath,
  forkSeedPaths,
  resolveDirectTrackedResumeSession,
  resumeFlow,
  findUntrackedSession,
  findTrackedCodexHomeRollout,
  sessionOwnersRoot,
  recordSessionOwner,
  recoverSessionIdentity,
  recoverSessionOwner,
  recoverResumeSessionIdentity,
  recoverResumeSessionOwner,
  exactTrackedResumePath,
  rehydrateOutOfWindowTrackedSession,
  exactTrackedResumeBySessionPath,
  transcriptOwnerFromConfigDir,
  recoverOutOfWindowTrackedSession,
  nativeSessionIdFromLaunchArgs,
  mintRecycleArgs,
  mintCarryRespawnArgs,
  latestCodexRollout,
  codexCarryLineageMarker,
  splitRespawnModelSpec,
  reconcileRespawnModelSpec,
  modelSpecFromRecycleArgv,
  detectRespawnModelSpec,
  stripKickoffPositional,
  claudeStoreHasSession,
  ensureResumeTranscriptPresent,
  sessionHasTranscript,
  sessionIsResumable,
  sessionTranscriptFile,
  lastActiveModelFor,
  resumeSessionLineageLabel,
  codexContextWindowConfigPatch,
  modelArgsFor,
  normalizeOmpModelSpec,
  ompModelCompatibilityNotice,
  readClaudeLaunchSettings,
  reconcileResumeModelForAccountRoute,
  ompTitleMitigationArgs,
  ompResponsesCompatibilityEnv,
  reportSessionEnded,
  pendingSessionEndWitnessPath,
  readPendingSessionEndWitness,
  NO_LIVE_CODEX_WRITER_EVIDENCE,
  NO_LIVE_CLAUDE_PROCESS_EVIDENCE,
  NO_LIVE_OMP_PROCESS_EVIDENCE,
  argvProbeSessionId,
  normalizeResumeLocalLivenessEvidence,
  normalizeCodexResumeLocalLivenessEvidence,
  normalizeArgvProbeResumeLocalLivenessEvidence,
  sessionProcessHolder,
  listProcPids,
  reportSessionResumed,
  acquireSessionResumeWithRecovery,
  reportSessionResumeFinalized,
  reportSessionResumeReleased,
  describeResumeClaimRefusal,
  announceAdoptedCarryRespawn,
  adoptedCarryRespawnFromHandoff,
  reportSessionRespawned,
  reportSessionRespawnedDurably,
  reportSessionPortDelivery,
  reportSessionPortLaunchFailure,
  sessionPortLaunchAbortError,
  launchFreshSu,
  tryRematerializeFromArchive,
  isClaudeConfigDirLaunchReady,
  ensureInteractiveConfigViaOperator,
  ensureCodexHomeViaOperator,
  ompLspArgs,
  roleLaunchArgs,
  suLaunchArgs,
  resolveOmpInjectHookPath,
  kickoffPositionalArgs,
  routeFreshKickoff,
  finalizeFreshSuArgs,
  tagKickoffProvenance,
  resolveKickoffText,
  scriptedOmpSetupEnv,
  finalizeFreshRoleArgs,
  resumeKickoffText,
  agentInvalidForRole,
  suWrapperExtraArgs,
  usePtyHost,
  PTY_DEFAULT_ON,
  AGENTS,
  PUI_TUI_ORIGIN,
  agentPickerChoices,
  puiWorkbenchCommand,
  launchPuiWorkbench,
  NO_PLAN,
  NATIVE_DEADWEIGHT_DENY_FLAG,
  NO_CHROME_FLAG,
  NATIVE_SCHEDULER_DENY_FLAG,
  SU_SCHEDULER_TOOLS_DENY_FLAG,
  NATIVE_TOOL_SEARCH_DENY_FLAG,
  nativeDeferralReachable,
  healContextTrimmingEnv,
  NO_SUBAGENTS_DENY_FLAG,
  subagentGatewayRiskNotice,
  OWNER_DESKTOP_NOTIFY_DENY_FLAG,
  BRAIN_TOMBSTONE_MESSAGE,
  reExecSafePermissionsFromArgs,
  persistReExecSafePermissions,
  persistDefaultClaudeAuthSettings,
  fetchWithResilience,
  formatApiFailureMessage,
  proxyOverloadRetryDelayMs,
  isRetryableMcpProxyOverload,
  BOOTSTRAP_REPLAY_MAX_ATTEMPTS,
  BOOTSTRAP_REPLAY_BUDGET_MS,
  MCP_PROXY_OVERLOAD_MAX_ATTEMPTS,
  MCP_PROXY_OVERLOAD_RETRY_BUDGET_MS,
  resolveFallbackOperatorTargets,
  resolveOperatorUrl,
  resolveOperatorTarget,
  applyLauncherOperatorUrlEnv,
  normalizeOperatorBaseUrl,
  readToken,
  claudeOAuthTokenPath,
  readStoredClaudeOAuthToken,
  applyDefaultClaudeOAuthToken,
  applyGithubTokenEnv,
  storeClaudeOAuthToken,
  fleetSlugFromName as launcherFleetSlugFromName,
  hexToRgb,
  colorSwatch,
  schemeNameInAccent,
  assertLaunchPersona,
  preflightWindowGuard,
  runLaunchPreflight,
  normalizeModelSpec,
  validateModelSpec,
  composeResumeModelSpec,
  RESUME_MODEL_MENU,
  RESUME_EFFORT_MENU,
  // WI-6321 parity sources. Aliased because the TS twins carry the same names.
  //
  // The alias is LOAD-BEARING, not cosmetic — do not "simplify" it away, and do not
  // re-add a bare `SU_CONTEXT_DEFAULT` / `SU_CONTEXT_TOKEN_ESTIMATES` from psu here.
  // Both names are imported bare from operator-core below, so importing them bare
  // from the launcher too declares each identifier twice. TypeScript says so (TS2300
  // ×6) but nothing else does: node ESM and esbuild's .mjs loader both reject a
  // duplicate binding as a hard SyntaxError, while esbuild's TS loader — the one
  // Vitest actually uses — silently accepts it and lets the LAST import win. So the
  // suite kept passing while every bare use in this file quietly resolved to
  // operator-core, including inside the psu-picker describe above that means to test
  // the launcher. It stayed invisible only because the two modules currently hold
  // identical values; the day they diverge is precisely the day these tests exist to
  // fire (EI-19423881269896227).
  SU_CONTEXT_CHOICES,
  SU_CONTEXT_TOKEN_ESTIMATES as PSU_SU_CONTEXT_TOKEN_ESTIMATES,
  SU_CONTEXT_DEFAULT as PSU_SU_CONTEXT_DEFAULT,
  resumeModelMenuFor,
  resolveResumeTarget,
  resumeTargetSelectionFromLastActive,
  sessionPortTargetAccount,
  sessionPortRequestBody,
  sessionPortTargetArgs,
  launchSessionPort,
  formatSessionPortInspection,
  sessionPortUpgradeError,
  SESSION_PORT_PROTOCOL_VERSION,
  SESSION_PORT_TRANSFORM_VERSION,
  cloudModelBackendHint,
  validateAgentModelPair,
  nativeCompactionEnv,
  setupReminderLines,
  AGENT_LABELS,
  whichBin,
  wellKnownBackendBin,
  classifyLiveHostActivity,
  LIVE_HOST_IDLE_THRESHOLD_MS,
  startSupervisorBeat,
  spawnInherit,
  printPsuResumeHint,
} from "../scripts/psu-launcher.mjs";
import {
  nativeSchedulerDenyFlag,
  suSchedulerToolsDenyFlag,
  NATIVE_SCHEDULER_TOOL_DENY,
  NATIVE_SCHEDULER_SKILL_DENY,
  NATIVE_SCHEDULER_DENY,
} from "@papercusp/orchestrator/native-scheduler-deny";
import {
  nativeToolSearchDenyFlag,
  nativeDeferralReachable as canonicalNativeDeferralReachable,
  nativeDeferralEnv as canonicalNativeDeferralEnv,
} from "@papercusp/orchestrator/native-tool-search-deny";
import { noSubagentToolsDenyFlag } from "@papercusp/orchestrator/no-subagent-deny";
import { ownerDesktopNotifyDenyFlag } from "@papercusp/orchestrator/owner-desktop-notify-deny";
import {
  ACCOUNT_HEADER,
  OWNER_HEADER,
} from "@papercusp/operator-core/lib/inference-gateway/gateway";
// P-042: the registry half of the launch-mode seam asserted at the bottom of
// this file — psu's parser is a hand-maintained literal that cannot see it.
import { LAUNCHABLE_MODE_IDS } from "@papercusp/operator-core/lib/modes/registry";
// R-12: the argv COMPOSER, so the cross-backend resume suite can round-trip the
// shared core's real output through psu's real parser instead of a hand-written
// argv. ⚠ Import ONLY the composer from here: agent-launch-core also exports a
// `resolveResumeTarget`, an unrelated adv_sessions lookup that collides by name
// with psu's backend resolver imported bare above — and per the note at the top
// of these imports, esbuild's TS loader resolves such a collision silently by
// letting the last one win.
import { buildAgentLaunchCommand } from "@papercusp/operator-core/lib/agent-launch-core";
import { GATEWAY_CLIENT_AUTH_TOKEN as SERVER_GATEWAY_CLIENT_AUTH_TOKEN } from "@papercusp/operator-core/lib/inference-gateway/spawn-env";
import { fleetSlugFromName as storeFleetSlugFromName } from "@papercusp/operator-core/lib/agent-fleets-store";
// WI-1993: the operator-core TS TWIN of validateModelSpec (node can't import the .mjs, so the
// tool boundary carries its own copy). The parity suite below pins them value-for-value.
import {
  validateCloudModelSpec,
  // WI-6300: the client-safe TS twins the UI pickers derive from. psu-launcher.mjs
  // cannot be imported by the browser bundle (node built-ins + inquirer), so the
  // renderer reads these instead — and the parity suite below pins them to the
  // launcher's own menus so a model/effort added to psu can never again leave the
  // HUD launcher silently behind (owner-reported 2026-07-27: the launcher offered
  // 4 of 7 models and 3 of 5 efforts).
  CLOUD_MODEL_MENU,
  MODEL_EFFORT_LEVELS,
  // WI-6321: the same discipline extended to the remaining psu launch pickers —
  // context size and the one shared model:effort spec composer.
  SU_CONTEXT_SIZES,
  SU_CONTEXT_TOKEN_ESTIMATES,
  SU_CONTEXT_DEFAULT,
  composeLaunchModelSpec,
} from "@papercusp/operator-core/lib/agent-config-constants";
// EI-7138: the operator-core TS TWIN of suWrapperExtraArgs's model:effort → CLI-flag mapping
// (same psu-launcher.mjs / operator-core import-boundary constraint as WI-1993 above — the
// mapping is duplicated by necessity, not oversight). The parity suite below pins them
// value-for-value so a fix landed in one (the codex effort-drop, found 2026-07-03) can never
// again silently miss the other.
import { applyRoleModel } from "@papercusp/operator-core/lib/harness-invoke-once";
import {
  ledgerPathForSid,
  tagTurnForInjection,
} from "@papercusp/operator-core/lib/turn-provenance/turn-provenance";
// weak-model-tool-tier: the canonical core spine — psu-launcher.mjs carries an
// inlined copy because it is a plain node script with no TS imports. The drift
// guard below keeps the OMP seed exactly aligned with every other trimmed client.
import { CORE_MCP_TOOL_NAMES } from "@papercusp/orchestrator";
// deterministic-tool-definition-delivery-2026-09-21: the GENERATED delivery map the
// launcher now reads. The guards below assert against it rather than re-listing 90 names,
// because a second hand list in the test file is the same hand-maintained copy the plan
// removed from the source — it would drift the moment the policy re-resolves.
import {
  CLAUDE_TOOL_DELIVERY as CLAUDE_TOOL_DELIVERY_ARTIFACT,
  CODEX_TOOL_DELIVERY as CODEX_TOOL_DELIVERY_ARTIFACT,
  OMP_TOOL_DELIVERY as OMP_TOOL_DELIVERY_ARTIFACT,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- generated .mjs data module, no type declarations.
} from "../scripts/tool-delivery.generated.mjs";

describe("interactive role picker", () => {
  it("selects the SU execution tier without an extra prompt or operator fetch", async () => {
    const select = vi.fn().mockResolvedValue("su");
    vi.doMock("@inquirer/prompts", () => ({ select }));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("Operator unavailable", "TimeoutError"),
    );
    try {
      await expect(pickRole()).resolves.toEqual({ role: "su", roles: [] });
      expect(select).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      vi.doUnmock("@inquirer/prompts");
    }
  });

  it("keeps invalid catalog rows visible and pins a choice from the next page", async () => {
    const revision = "a".repeat(64);
    const choices = identityPickerChoices({ identities: [{ id: 'needs-producer', tier: 'installed',
      version: '1.0.0', sourceRevision: 'a'.repeat(64),
      slots: [{ slot: 'domain', cardinality: 'exclusive' }],
      launchCompatibility: { eligible: false, reason: 'Needs live producer binding' } }], unreadable: [
      { id: "broken", error: "attestation-missing" },
    ], nextAfter: "first" });
    expect(choices).toContainEqual(expect.objectContaining({ value: 'domain:needs-producer',
      disabled: 'Needs live producer binding' }));
    expect(choices.find((choice) => choice.value === 'domain:needs-producer')?.name)
      .toContain(revision.slice(0, 12));
    expect(choices).toContainEqual(expect.objectContaining({
      name: expect.stringContaining("broken  ·  invalid: attestation-missing"),
      disabled: "attestation-missing",
    }));
    const select = vi.fn().mockResolvedValueOnce("__next__")
      .mockResolvedValueOnce("domain:research-steward");
    vi.doMock("@inquirer/prompts", () => ({ select }));
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", identities: [],
        unreadable: [], nextAfter: "first" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", identities: [{
        id: "research-steward", tier: "installed", version: "1.2.0",
        sourceRevision: revision, slots: [{ slot: "domain", cardinality: "exclusive" }],
      }], unreadable: [], nextAfter: null }), { status: 200 }));
    try {
      await expect(pickIdentity("default", "papercusp")).resolves.toEqual({
        stack: ["domain:research-steward"], selectedIdentityRevision: revision,
      });
      expect(select).toHaveBeenCalledTimes(2);
      expect(String(fetch.mock.calls[1]?.[0])).toContain("after=first");
    } finally {
      fetch.mockRestore();
      vi.doUnmock("@inquirer/prompts");
    }
  });

  it('offers a launchable named composition root with its closure revision', async () => {
    const revision = 'b'.repeat(64);
    const page = { status: 'ok', identities: [{ id: 'named-review', tier: 'local',
      version: '1.0.0', sourceRevision: revision, slots: [],
      launchCompatibility: { eligible: true, reason: null } }], unreadable: [], nextAfter: null };
    const pickerChoices = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
      ? (await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)).identityPickerChoices
      : identityPickerChoices;
    expect(pickerChoices(page)).toContainEqual(expect.objectContaining({
      value: 'composition:named-review',
    }));
    const select = vi.fn().mockResolvedValue('composition:named-review');
    vi.doMock('@inquirer/prompts', () => ({ select }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(page), { status: 200 }));
    try {
      await expect(pickIdentity('default', 'papercusp')).resolves.toEqual({
        stack: ['composition:named-review'], selectedIdentityRevision: revision,
      });
    } finally {
      fetch.mockRestore();
      vi.doUnmock('@inquirer/prompts');
    }
  });
});

describe("normalizeOperatorBaseUrl (WI-6821 DEFECT A — a suffixed pin killed psu in 0.4s)", () => {
  const noWarn = { warn: () => {} };

  it("strips a trailing /api/mcp — the shape that made every operator call 404", () => {
    // Reproduced with a one-variable control: the bare base launched cleanly
    // (exit 0), this value died `not_found` in 0.4s, closing its terminal window.
    expect(
      normalizeOperatorBaseUrl("http://127.0.0.1:3070/api/mcp", noWarn),
    ).toBe("http://127.0.0.1:3070");
    expect(
      normalizeOperatorBaseUrl("http://localhost:3070/api/mcp/", noWarn),
    ).toBe("http://localhost:3070");
  });

  it("drops the signed query that rides on the agent MCP url", () => {
    // The suffixed form in the wild is the agent MCP url, whose ?sid=… addresses
    // /api/mcp specifically — carrying it onto a base is misleading, not merely
    // redundant.
    expect(
      normalizeOperatorBaseUrl(
        "http://127.0.0.1:9071/api/mcp?sid=abc&x=1",
        noWarn,
      ),
    ).toBe("http://127.0.0.1:9071");
  });

  it("WARNS when it rewrites, naming the variable and both urls", () => {
    // A silent rewrite would hide the misconfiguration from whoever must fix the
    // exporting environment — the rewrite keeps psu alive, the warning fixes the cause.
    const warnings: string[] = [];
    normalizeOperatorBaseUrl("http://localhost:3070/api/mcp", {
      warn: (m: string) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("PAPERCUSP_OPERATOR_URL");
    expect(warnings[0]).toContain("http://localhost:3070/api/mcp");
    expect(warnings[0]).toContain("BARE BASE");
  });

  it("leaves an already-correct base alone, silently", () => {
    const warnings: string[] = [];
    const w = { warn: (m: string) => warnings.push(m) };
    expect(normalizeOperatorBaseUrl("http://127.0.0.1:9071", w)).toBe(
      "http://127.0.0.1:9071",
    );
    expect(normalizeOperatorBaseUrl("http://localhost:3070/", w)).toBe(
      "http://localhost:3070",
    );
    expect(warnings).toEqual([]);
  });

  it("does NOT strip a path that merely CONTAINS api/mcp", () => {
    // Only a TRAILING segment is unambiguous — a base can never legitimately end
    // in the path about to be appended. Anything else is a real path, not a mistake.
    expect(normalizeOperatorBaseUrl("http://host/api/mcp/proxy", noWarn)).toBe(
      "http://host/api/mcp/proxy",
    );
    expect(normalizeOperatorBaseUrl("http://host/mcp", noWarn)).toBe(
      "http://host/mcp",
    );
  });

  it("returns junk untouched rather than silently inventing a url", () => {
    // The connection path reports an unusable value far better than a rewrite that
    // guesses — and a non-string must not throw here.
    expect(normalizeOperatorBaseUrl("not a url", noWarn)).toBe("not a url");
    expect(normalizeOperatorBaseUrl("", noWarn)).toBe("");
    expect(normalizeOperatorBaseUrl(undefined as any, noWarn)).toBe(undefined);
  });

  it("resolveOperatorTarget applies it to the env override branch", () => {
    // The env branch was the ONLY one that could return a path-suffixed url; every
    // other branch already returns a bare base.
    const t = resolveOperatorTarget({
      env: {
        NODE_ENV: "test",
        PAPERCUSP_OPERATOR_URL: "http://localhost:3070/api/mcp",
        PAPERCUSP_MCP_PROXY: "0",
      },
      home: "/nonexistent-home-for-this-test",
      probe: () => false,
      warn: () => {},
    });
    expect(t.url).toBe("http://localhost:3070");
    expect(t.source).toBe("env");
  });
});

describe("classifyLiveHostActivity (EI-20289007209260909 — process-alive husk diagnosis)", () => {
  const now = Date.parse("2026-08-12T23:00:00.000Z");

  it("treats recent headless activity as active", () => {
    expect(
      classifyLiveHostActivity(
        { bridgeTty: false, lastActivityAt: now - 5 * 60_000 },
        { now, idleThresholdMs: 30 * 60_000 },
      ),
    ).toEqual({
      state: "active",
      lastActivityAt: now - 5 * 60_000,
      idleMs: 5 * 60_000,
    });
  });

  it("calls a stale headless host abandoned, while retaining the measured age", () => {
    const lastActivityAt = now - 31 * 60_000;
    expect(
      classifyLiveHostActivity(
        { bridgeTty: false, lastActivityAt },
        { now, idleThresholdMs: 30 * 60_000 },
      ),
    ).toEqual({ state: "abandoned", lastActivityAt, idleMs: 31 * 60_000 });
  });

  it("only calls a stale bridged host idle, never abandoned", () => {
    const lastActivityAt = now - 31 * 60_000;
    expect(
      classifyLiveHostActivity(
        { bridgeTty: true, lastActivityAt },
        { now, idleThresholdMs: 30 * 60_000 },
      ),
    ).toEqual({ state: "idle", lastActivityAt, idleMs: 31 * 60_000 });
  });

  it("falls back to the newest input/output sample and stays unknown when unmeasured", () => {
    expect(
      classifyLiveHostActivity(
        {
          bridgeTty: false,
          lastOutputAt: now - 40 * 60_000,
          lastInputAt: now - 2 * 60_000,
        },
        { now, idleThresholdMs: 30 * 60_000 },
      ),
    ).toMatchObject({
      state: "active",
      lastActivityAt: now - 2 * 60_000,
      idleMs: 2 * 60_000,
    });
    expect(classifyLiveHostActivity({ bridgeTty: false }, { now })).toEqual({
      state: "unknown",
      lastActivityAt: null,
      idleMs: null,
    });
  });

  it("keeps a positive default threshold so the guard never treats every live host as stale", () => {
    expect(LIVE_HOST_IDLE_THRESHOLD_MS).toBeGreaterThan(0);
  });
});

describe("backend-not-installed helpers (owner req 2026-07-06 — psu prompt-to-install)", () => {
  it("AGENT_LABELS names all three backends", () => {
    expect(AGENT_LABELS.claude).toMatch(/Claude/);
    expect(AGENT_LABELS.codex).toMatch(/Codex/);
    expect(AGENT_LABELS.omp).toMatch(/oh-my-pi/);
  });

  it("whichBin returns null for a binary that cannot exist", () => {
    expect(whichBin("definitely-not-a-real-binary-xyz-123")).toBeNull();
  });

  it("wellKnownBackendBin finds a bin the setup flow installed under a known path", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-wk-"));
    try {
      // omp installer target on unix: ~/.local/bin/omp
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(join(home, ".local", "bin", "omp"), "#!/bin/sh\n");
      expect(
        wellKnownBackendBin("omp", { home, env: { NODE_ENV: "test" } }),
      ).toBe(join(home, ".local/bin/omp"));
      // codex installer target: ~/.papercusp/runtime/node_modules/.bin/codex
      mkdirSync(join(home, ".papercusp", "runtime", "node_modules", ".bin"), {
        recursive: true,
      });
      writeFileSync(
        join(home, ".papercusp", "runtime", "node_modules", ".bin", "codex"),
        "",
      );
      expect(
        wellKnownBackendBin("codex", { home, env: { NODE_ENV: "test" } }),
      ).toBe(join(home, ".papercusp/runtime/node_modules/.bin/codex"));
      // nothing installed → null
      expect(
        wellKnownBackendBin("claude", { home, env: { NODE_ENV: "test" } }),
      ).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("wellKnownBackendBin honors %USERPROFILE% for the Windows omp path", () => {
    const winHome = mkdtempSync(join(tmpdir(), "psu-win-"));
    try {
      mkdirSync(join(winHome, ".papercusp", "bin"), { recursive: true });
      writeFileSync(join(winHome, ".papercusp", "bin", "omp.exe"), "");
      // home has no omp; USERPROFILE does → resolves via the winHome candidate.
      // `platform: 'win32'` is REQUIRED, not decoration: %USERPROFILE% is a
      // Windows concept and the shared resolver gates those candidates behind
      // the platform, so a POSIX-defaulted call correctly never looks there.
      // (WI-37920: this case previously passed only because the pre-shared list
      // probed a winHome path unconditionally, on every OS.)
      const home = mkdtempSync(join(tmpdir(), "psu-home-"));
      try {
        expect(
          wellKnownBackendBin("omp", {
            home,
            env: { NODE_ENV: "test", USERPROFILE: winHome },
            platform: "win32",
          }),
        ).toBe(join(winHome, ".papercusp", "bin", "omp.exe"));
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(winHome, { recursive: true, force: true });
    }
  });
});

describe("launch-options menu reuse", () => {
  it("shares an in-flight read and reuses the active workspace for harness and fleet menus", async () => {
    let resolve!: (page: object) => void;
    const request = vi.fn((_path: string) => new Promise<object>((done) => { resolve = done; }));
    const read = createLaunchOptionsReader({ request });
    const first = read();
    const concurrent = read({ include: "harnesses,workspaces,fleets" });
    expect(concurrent).toBe(first);
    await Promise.resolve();
    resolve({ workspace: "ws1", harnesses: [{ slug: "app" }], fleets: [] });
    const page = await first;
    expect(await read({ workspace: "ws1" })).toBe(page);
    expect(await read({ workspace: "ws1" })).toBe(page);
    expect(request).toHaveBeenCalledTimes(1);
    expect(new URL(request.mock.calls[0]![0], "http://operator").searchParams.get("include"))
      .toBe("fleets,harnesses,workspaces");
  });

  it("keeps provider, workspace, section and operator data separate", async () => {
    let origin = "operator-a";
    const request = vi.fn(async (_path: string) => ({ accounts: { pool: [] } }));
    const read = createLaunchOptionsReader({ request, scope: () => origin });
    await read({ workspace: "ws1", agent: "claude", include: "accounts" });
    await read({ workspace: "ws1", agent: "codex", include: "accounts" });
    await read({ workspace: "ws2", agent: "codex", include: "accounts" });
    await read({ workspace: "ws2", include: "ompCatalog" });
    origin = "operator-b";
    await read({ workspace: "ws1", agent: "codex", include: "accounts" });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("expires snapshots and does not retain failed requests", async () => {
    let clock = 0;
    const request = vi.fn(async (_path: string) => ({ workspace: "ws1" }));
    const read = createLaunchOptionsReader({ request, now: () => clock, maxAgeMs: 30_000 });
    await read();
    clock = 29_999;
    await read({ workspace: "ws1" });
    expect(request).toHaveBeenCalledTimes(1);
    clock = 30_000;
    await read({ workspace: "ws1" });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockRejectedValueOnce(new Error("operator restarting"));
    await expect(read({ workspace: "ws2" })).rejects.toThrow("operator restarting");
    await read({ workspace: "ws2" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not block an earlier menu on a pending account read", async () => {
    const request = vi.fn(async (path: string) => {
      const include = new URL(path, "http://operator").searchParams.get("include");
      if (include === "accounts") return new Promise<object>(() => {});
      return { workspace: "ws1", harnesses: [] };
    });
    const read = createLaunchOptionsReader({ request });
    void read({ workspace: "ws1", agent: "claude", include: "accounts" });
    expect(await read({ workspace: "ws1" })).toEqual({ workspace: "ws1", harnesses: [] });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("tagKickoffProvenance (turn-provenance-owner-vs-agent-2026-07-11 P-002)", () => {
  let provDir: string;
  beforeEach(() => {
    provDir = mkdtempSync(join(tmpdir(), "kickoff-prov-"));
  });
  afterEach(() => {
    rmSync(provDir, { recursive: true, force: true });
  });
  const envFor = (): NodeJS.ProcessEnv => ({
    NODE_ENV: "test",
    PAPERCUSP_TURN_PROVENANCE_DIR: provDir,
  });

  it("prefixes the fleet-kickoff envelope and writes the ledger row FIRST (lockstep JSONL shape)", () => {
    const tagged = tagKickoffProvenance(
      "Begin: advance this plan.",
      "su-kick-1",
      envFor(),
      1_760_000_000_000,
    );
    expect(tagged).toMatch(
      /^⟦turn-origin:fleet-kickoff nonce:[a-f0-9]{16}⟧\nBegin: advance this plan\.$/,
    );
    const raw = readFileSync(join(provDir, "su-kick-1.jsonl"), "utf8").trim();
    const row = JSON.parse(raw);
    expect(row).toMatchObject({
      sid: "su-kick-1",
      origin: "fleet-kickoff",
      ts: 1_760_000_000_000,
    });
    expect(row.nonce).toMatch(/^[a-f0-9]{16}$/);
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tagged).toContain(row.nonce); // the typed envelope references the ledger row
  });

  it("consumes a private loop-fire origin for one fresh kickoff, then restores fleet-kickoff", () => {
    const env = {
      ...envFor(),
      PAPERCUSP_SID: "su-loop-kick-1",
      PAPERCUSP_INTERNAL_KICKOFF_ORIGIN: "loop-fire",
    };
    const args = { picker: false };
    const first = routeFreshKickoff(
      "claude",
      { kickoffPrompt: "Continue the persisted loop." },
      args,
      env,
    );
    expect(first.managedKickoff).toMatch(/^⟦turn-origin:loop-fire nonce:[a-f0-9]{16}⟧\nContinue the persisted loop\.$/);
    expect(env).not.toHaveProperty("PAPERCUSP_INTERNAL_KICKOFF_ORIGIN");

    const second = routeFreshKickoff(
      "claude",
      { kickoffPrompt: "A normal scripted kickoff." },
      args,
      env,
    );
    expect(second.managedKickoff).toMatch(/^⟦turn-origin:fleet-kickoff nonce:[a-f0-9]{16}⟧\nA normal scripted kickoff\.$/);
    const rows = readFileSync(join(provDir, "su-loop-kick-1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.origin)).toEqual(["loop-fire", "fleet-kickoff"]);
  });

  it("pins the launcher mirror to the canonical turn-provenance contract", async () => {
    const sid = "su/kickoff .. id";
    const text = " Begin: advance this plan.\r\n";
    const nowMs = 1_760_000_000_000;
    const canonicalDir = mkdtempSync(join(tmpdir(), "kickoff-prov-ts-"));
    const mirrorDir = mkdtempSync(join(tmpdir(), "kickoff-prov-mjs-"));
    try {
      const canonical = await tagTurnForInjection({
        sid,
        origin: "fleet-kickoff",
        text,
        dir: canonicalDir,
        nowMs,
      });
      const mirror = tagKickoffProvenance(
        text,
        sid,
        { ...envFor(), PAPERCUSP_TURN_PROVENANCE_DIR: mirrorDir },
        nowMs,
      );
      const canonicalPath = ledgerPathForSid(sid, canonicalDir);
      const mirrorPath = join(mirrorDir, basename(canonicalPath));
      const canonicalRow = JSON.parse(readFileSync(canonicalPath, "utf8").trim());
      const mirrorRow = JSON.parse(readFileSync(mirrorPath, "utf8").trim());
      const withoutNonce = (row: Record<string, unknown>) => ({
        ...row,
        nonce: "<nonce>",
      });

      // The mirror must use the same routing key and emit the same row contract;
      // only the independently minted nonce is expected to differ.
      expect(existsSync(mirrorPath)).toBe(true);
      expect(Object.keys(mirrorRow).sort()).toEqual(Object.keys(canonicalRow).sort());
      expect(withoutNonce(mirrorRow)).toEqual(withoutNonce(canonicalRow));

      const envelope = (tagged: string) => {
        const line = tagged.slice(0, tagged.indexOf("\n"));
        return { line, nonce: line.match(/nonce:([a-f0-9]+)⟧$/)?.[1] };
      };
      const canonicalEnvelope = envelope(canonical.taggedText);
      const mirrorEnvelope = envelope(mirror);
      expect(canonicalEnvelope.nonce).toBe(canonical.nonce);
      expect(mirrorEnvelope.nonce).toBe(mirrorRow.nonce);
      expect(mirrorEnvelope.nonce?.length).toBe(canonicalEnvelope.nonce?.length);
      expect(
        canonicalEnvelope.line.replace(canonicalEnvelope.nonce!, "<nonce>"),
      ).toBe(mirrorEnvelope.line.replace(mirrorEnvelope.nonce!, "<nonce>"));
    } finally {
      rmSync(canonicalDir, { recursive: true, force: true });
      rmSync(mirrorDir, { recursive: true, force: true });
    }
  });

  it("no sid (interactive/untracked launch) → untagged text, no ledger write", () => {
    expect(tagKickoffProvenance("hello", null, envFor())).toBe("hello");
    expect(existsSync(join(provDir, "unknown.jsonl"))).toBe(false);
  });

  it("fail-soft: an unwritable ledger dir still returns the untagged text (never a broken launch)", () => {
    // ⚠ NEVER '/proc/…' here: node 25's recursive mkdirSync retries /proc's
    // EPERM forever (wedged every gate for hours on 2026-07-11). A plain file
    // as the path's parent throws ENOTDIR instantly instead.
    const plainFile = join(provDir, "plain-file");
    writeFileSync(plainFile, "x");
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PAPERCUSP_TURN_PROVENANCE_DIR: join(plainFile, "sub"),
    };
    expect(tagKickoffProvenance("hello", "su-kick-2", env)).toBe("hello");
  });

  it("sanitizes the sid into the ledger filename", () => {
    tagKickoffProvenance("x", "su/../evil id", envFor());
    expect(existsSync(join(provDir, "su_.._evil_id.jsonl"))).toBe(true);
  });
});

describe("shared launch model alias parsing", () => {
  it("resolves a human versioned selector before selecting the backend", () => {
    expect(parseArgs(["--no-picker", "--model=sol 6.1:xhigh"])).toMatchObject({
      agent: "codex", model: "gpt-6.1-sol:xhigh", modelSource: "explicit",
    });
  });

  it("refuses unknown and ambiguous human selectors before bootstrap", () => {
    expect(() => parseArgs(["--no-picker", "--model=mystery"])).toThrow(/Unknown model alias/);
    expect(() => parseArgs(["--no-picker", "--model=6"])).toThrow(/ambiguous.*gpt-6-sol.*gpt-6-astra/);
  });
});

describe("kickoffPositionalArgs (EI-5503 plan auto-kickoff)", () => {
  const KICK =
    "Begin: advance this plan. Read the `## Now` block, pick up the next actionable item, and work it.";
  it("seeds the kickoff for a scripted (--no-picker) plan launch", () => {
    const res = { kickoffPrompt: KICK, planSlug: "p" };
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=x",
      "--plan=p",
    ]);
    expect(kickoffPositionalArgs(res, args)).toEqual([KICK]);
  });
  it("is empty for an interactive picker launch (picker !== false)", () => {
    const res = { kickoffPrompt: KICK, planSlug: "p" };
    expect(kickoffPositionalArgs(res, parseArgs([]))).toEqual([]);
  });
  it("is empty when --no-kickoff opts out", () => {
    const res = { kickoffPrompt: KICK, planSlug: "p" };
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=x",
      "--plan=p",
      "--no-kickoff",
    ]);
    expect((args as { kickoff?: boolean }).kickoff).toBe(false);
    expect(kickoffPositionalArgs(res, args)).toEqual([]);
  });
  it("is empty when the server supplied no kickoff (no plan bound)", () => {
    const args = parseArgs(["--no-picker", "--agent=claude", "--harness=x"]);
    expect(kickoffPositionalArgs({ kickoffPrompt: null }, args)).toEqual([]);
    expect(kickoffPositionalArgs({}, args)).toEqual([]);
  });
  it("default parse has no kickoff key (so the gate treats it as enabled)", () => {
    expect((parseArgs([]) as { kickoff?: boolean }).kickoff).toBeUndefined();
  });
  it("WI-10004449: --fleet-role=leader boots a --fleet launch as leader, in either order", () => {
    type FleetArgs = { fleet: string | null; fleetRole: string | null };
    const after = parseArgs(["--fleet=f1", "--fleet-role=leader"]) as unknown as FleetArgs;
    const before = parseArgs(["--fleet-role=leader", "--fleet=f1"]) as unknown as FleetArgs;
    const spaced = parseArgs(["--fleet-role=leader", "--fleet", "f1"]) as unknown as FleetArgs;
    for (const a of [after, before, spaced]) expect([a.fleet, a.fleetRole]).toEqual(["f1", "leader"]);
    // No flag, or an invalid value, keeps the member default.
    expect((parseArgs(["--fleet=f1"]) as unknown as FleetArgs).fleetRole).toBe("member");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((parseArgs(["--fleet=f1", "--fleet-role=boss"]) as unknown as FleetArgs).fleetRole).toBe("member");
      expect(warn).toHaveBeenCalledWith("psu: ignoring --fleet-role=boss (expected leader|member)");
    } finally {
      warn.mockRestore();
    }
  });

  // Free-form --kickoff (the general, plan-independent first-turn seam used by the
  // desktop tutorial's docs-agent launcher).
  it("a free-form --kickoff seeds the first turn with NO plan bound", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--kickoff=answer this: what is a pot?",
    ]);
    expect(args.kickoffPromptText).toBe("answer this: what is a pot?");
    expect(kickoffPositionalArgs({}, args)).toEqual([
      "answer this: what is a pot?",
    ]);
  });
  it("--kickoff wins over the server plan-derived kickoff", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--kickoff=my question",
    ]);
    expect(
      kickoffPositionalArgs({ kickoffPrompt: KICK, planSlug: "p" }, args),
    ).toEqual(["my question"]);
  });
  it("--kickoff still respects --no-picker (interactive picker → empty) and --no-kickoff", () => {
    expect(
      kickoffPositionalArgs({}, parseArgs(["--agent=claude", "--kickoff=q"])),
    ).toEqual([]); // picker launch
    expect(
      kickoffPositionalArgs(
        {},
        parseArgs([
          "--no-picker",
          "--agent=claude",
          "--kickoff=q",
          "--no-kickoff",
        ]),
      ),
    ).toEqual([]);
  });
});

describe("routeFreshKickoff (EI-20339142329504181 OMP startup barrier)", () => {
  const KICK = "Begin: advance the admitted work item.";

  it("keeps the interactive setup reminder on the routed kickoff result", () => {
    const src = readFileSync(
      join(__dirname, "..", "scripts", "psu-launcher.mjs"),
      "utf8",
    );
    const reminderBlock = src.slice(
      src.indexOf(
        "// Owner batch #5: right before the TUI takes over the terminal",
      ),
      src.indexOf(
        "// codex's superuser bearer is baked into its per-session config.toml",
      ),
    );
    expect(reminderBlock).toContain("!kickoff.kickoffSeeded");
    expect(reminderBlock).not.toContain("kickoffArgs");
  });

  it("routes every fresh backend kickoff through the managed pty instead of argv", () => {
    const provenanceDir = mkdtempSync(join(tmpdir(), "omp-kickoff-prov-"));
    try {
      for (const backend of ["claude", "codex", "omp"]) {
        const args = parseArgs([
          "--no-picker",
          `--agent=${backend}`,
          "--plan=p",
          ...(backend === "codex"
            ? ["--model=gpt-5.6-sol:xhigh", "--model-source=explicit"]
            : []),
        ]);
        const result = routeFreshKickoff(
          backend,
          {
            kickoffPrompt: KICK,
            planSlug: "p",
            envelopeEnv: { PAPERCUSP_SID: `${backend}-1` },
          },
          args,
          {
            PAPERCUSP_SID: `${backend}-1`,
            PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
          },
        );

        expect(result.positionalArgs).toEqual([]);
        expect(result.kickoffSeeded).toBe(true);
        expect(result.managedKickoff).toMatch(
          /^⟦turn-origin:fleet-kickoff nonce:[a-f0-9]{16}⟧\nBegin: advance the admitted work item\.$/,
        );
      }
    } finally {
      rmSync(provenanceDir, { recursive: true, force: true });
    }
  });

  it("does not create a managed kickoff for picker, no-kickoff, or absent-kickoff launches", () => {
    const res = {
      kickoffPrompt: KICK,
      planSlug: "p",
      envelopeEnv: { PAPERCUSP_SID: "omp-1" },
    };
    expect(
      routeFreshKickoff("omp", res, parseArgs(["--agent=omp"]), {}),
    ).toEqual({
      positionalArgs: [],
      managedKickoff: null,
      kickoffSeeded: false,
    });
    expect(
      routeFreshKickoff(
        "omp",
        res,
        parseArgs(["--no-picker", "--agent=omp", "--no-kickoff"]),
        {},
      ),
    ).toEqual({
      positionalArgs: [],
      managedKickoff: null,
      kickoffSeeded: false,
    });
    expect(
      routeFreshKickoff(
        "omp",
        { envelopeEnv: { PAPERCUSP_SID: "omp-1" } },
        parseArgs(["--no-picker", "--agent=omp"]),
        {},
      ),
    ).toEqual({
      positionalArgs: [],
      managedKickoff: null,
      kickoffSeeded: false,
    });
  });
});

describe("OMP managed-session title isolation (WI-287139)", () => {
  it("disables provider-backed auto-title for every model, including the default", () => {
    for (const model of [
      null,
      "stealth/ox-alpha",
      "stealth/ox-alpha:max",
      "openrouter/stealth/ox-alpha:high",
      "openrouter/other/model:max",
      "claude-sonnet-4-6:high",
    ]) {
      expect(ompTitleMitigationArgs(model)).toEqual(["--no-title"]);
    }
  });

  it("applies to fresh role, fresh SU launch, fresh SU wrapper, and resume argv with or without an explicit model", () => {
    const model = "papercusp-gateway/claude-sonnet-4-6";
    expect(
      roleLaunchArgs("omp", { promptFile: "/p.md", model }).args,
    ).toContain("--no-title");
    expect(suWrapperExtraArgs("omp", { model })).toContain("--no-title");
    // suLaunchArgs is the INTERACTIVE fresh-SU launch, distinct from the
    // suWrapperExtraArgs wrapper above, and it is the path WI-287139 actually
    // found missing the flag. It was covered only incidentally by the exact-argv
    // assertion further down, so this "every path funnels through the helper"
    // guard could not catch the omission — which is precisely how it survived.
    // It takes no model parameter, hence no with/without-model variant.
    expect(
      suLaunchArgs("omp", { promptFile: "/p.md" }).args,
    ).toContain("--no-title");
    expect(
      resumeArgsFor({ agent: "omp", cwd: "/x", ompThreadId: "thr-1" }, {
        model,
      } as unknown as Parameters<typeof resumeArgsFor>[1]).args,
    ).toContain("--no-title");
    expect(
      roleLaunchArgs("omp", { promptFile: "/p.md" }).args,
    ).toContain("--no-title");
    expect(suWrapperExtraArgs("omp")).toContain("--no-title");
    expect(
      resumeArgsFor({ agent: "omp", cwd: "/x", ompThreadId: "thr-1" }, {
        model: null,
      } as unknown as Parameters<typeof resumeArgsFor>[1]).args,
    ).toContain("--no-title");
  });
});

describe("OMP ox-alpha Responses compatibility guard (EI-21439300345381616)", () => {
  it("disables the Responses route only for exact ox-alpha models", () => {
    for (const model of [
      "stealth/ox-alpha",
      "stealth/ox-alpha:max",
      "openrouter/stealth/ox-alpha:high",
    ]) {
      expect(ompResponsesCompatibilityEnv("omp", model, {})).toEqual({
        PI_OPENROUTER_RESPONSES: "0",
      });
    }
    for (const [agent, model] of [
      ["claude", "stealth/ox-alpha"],
      ["omp", "openrouter/other/model:max"],
      ["omp", "stealth/ox-alpha-preview:max"],
      ["omp", null],
    ] as const) {
      expect(ompResponsesCompatibilityEnv(agent, model, {})).toEqual({});
    }
  });

  it("preserves an explicit PI_OPENROUTER_RESPONSES override", () => {
    expect(
      ompResponsesCompatibilityEnv("omp", "stealth/ox-alpha", {
        PI_OPENROUTER_RESPONSES: "1",
      }),
    ).toEqual({});
    expect(
      ompResponsesCompatibilityEnv("omp", "stealth/ox-alpha", {
        PI_OPENROUTER_RESPONSES: "",
      }),
    ).toEqual({});
  });

  it("is wired into fresh role, fresh SU, and resume env assembly", () => {
    const source = readFileSync(
      join(__dirname, "..", "scripts", "psu-launcher.mjs"),
      "utf8",
    );
    const roleBody = source.slice(source.indexOf("async function roleFlow("));
    const freshBody = source.slice(source.indexOf("async function launchFreshSu("));
    const resumeBody = source.slice(source.indexOf("async function launchResume("));
    expect(roleBody).toContain(
      "ompResponsesCompatibilityEnv(res.agent, roleModel",
    );
    expect(roleBody).toContain(
      "await writeOmpSessionConfigDirAsync(res.sessionId",
    );
    expect(roleBody).toContain("const bootstrapIdempotencyKey = randomUUID();");
    expect(roleBody).toContain("bootstrapIdempotencyKey,");
    expect(roleBody).toContain("retryBootstrapFailures: true");
    expect(roleBody).toContain(
      'mcpJsonContents: readFileSync(requireOmpRoleMcpJsonPath(res), "utf8")',
    );
    expect(roleBody).not.toContain(
      'res.agent === "omp" && res.envelopeEnv?.PAPERCUSP_OMP_MODELS_YML',
    );
    expect(freshBody).toContain("ompResponsesCompatibilityEnv(");
    expect(freshBody).toContain(
      "await writeOmpSessionConfigDirAsync(res.sessionId",
    );
    expect(resumeBody).toContain(
      "lastActiveModelFor(session) || ompDefaultModel()",
    );
    expect(resumeBody).toContain(
      "ompResponsesCompatibilityEnv(session.agent, resumeModel, env)",
    );
  });
});

describe("Codex retired-model deny wiring (WI-2140343 — the Spark fall-through)", () => {
  const launcherSource = () =>
    readFileSync(join(__dirname, "..", "scripts", "psu-launcher.mjs"), "utf8");

  it("hands the real deny list to the resume model picker", () => {
    const body = launcherSource().slice(
      launcherSource().indexOf("async function chooseResumeTarget("),
    );
    // The picker is the boundary where a RETIRED id becomes typeable again.
    // codexModelRows filters `deniedIds` but DEFAULTS IT TO [] — so the filter
    // only exists if this call site actually passes the policy list. Dropping
    // this one line put gpt-5.3-codex-spark back on the menu with the whole
    // suite still green.
    expect(body).toContain("codexDeniedIds: CODEX_DENIED_MODEL_IDS");
  });

  it("takes that list from the policy module, not a local literal that can drift", () => {
    expect(launcherSource()).toMatch(
      /import\s*\{[^}]*CODEX_DENIED_MODEL_IDS[^}]*\}\s*from\s*["'][^"']*model-context-budget\.mjs["']/,
    );
  });

  it("builds the codex model menu in exactly ONE place, so no second picker is unguarded", () => {
    // A guarded call site proves nothing if a later fresh-launch picker builds
    // its own rows without the deny list. Pin the count instead of the line.
    expect(launcherSource().match(/buildResumeModelRows\(\{/g) ?? []).toHaveLength(1);
  });
});

describe("Codex missing-model posture", () => {
  it.each(["system", "auto"])("inherits the native configured model on a fresh %s account launch", (account) => {
    const args = parseArgs(["--agent=codex", `--account=${account}`]);
    const readConfig = vi.fn(() => 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
    const inherited = inheritFreshCodexConfiguredModel("codex", args, {
      home: "/native-home", readConfig,
    });
    const body = freshSuBootstrapBody(
      { agent: "codex", workspace: "papercusp-workspace", harness: null, plan: null },
      inherited,
    );
    expect(readConfig).toHaveBeenCalledWith("/native-home/.codex/config.toml", "utf8");
    expect(body).toMatchObject({ model: "gpt-6.1-sol:xhigh", model_source: "inherited", account });
    expect(body.launch_argv).toEqual(expect.arrayContaining([
      "--model=gpt-6.1-sol:xhigh", "--model-source=inherited", `--account=${account}`,
    ]));
    expect(args.modelSource).toBe("configured-default");
  });

  it("preserves explicit models and unattended selection rather than reading native defaults", () => {
    const readConfig = vi.fn(() => 'model = "gpt-6.1-sol"\n');
    for (const flags of [
      ["--agent=codex", "--model=gpt-6-sol:high"],
      ["--headless", "--agent=codex", "--model-source=configured-default"],
      ["--no-picker", "--agent=codex", "--model-source=configured-default"],
    ]) {
      const args = parseArgs(flags);
      expect(inheritFreshCodexConfiguredModel("codex", args, { readConfig })).toBe(args);
    }
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("keeps the policy default when native model configuration is absent", () => {
    const args = parseArgs(["--agent=codex"]);
    expect(inheritFreshCodexConfiguredModel("codex", args, { readConfig: () => "" })).toBe(args);
    expect(inheritFreshCodexConfiguredModel("codex", args, {
      readConfig: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    })).toBe(args);
    expect(() => inheritFreshCodexConfiguredModel("codex", args, {
      readConfig: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    })).toThrow("denied");
  });

  it("rejects forbidden native models and ignores profile-local overrides", () => {
    const args = parseArgs(["--agent=codex"]);
    expect(() => inheritFreshCodexConfiguredModel("codex", args, {
      readConfig: () => 'model = "gpt-5.3-codex-spark"\n',
    })).toThrow(/denied/);
    expect(inheritFreshCodexConfiguredModel("codex", args, {
      readConfig: () => '[profiles.other]\nmodel = "gpt-6-sol"\n',
    })).toBe(args);
    expect(inheritFreshCodexConfiguredModel("codex", args, {
      readConfig: () => "model = 'gpt-6.1-sol' # native choice\nmodel_reasoning_effort = 'xhigh'\n",
    })).toMatchObject({ model: "gpt-6.1-sol:xhigh", modelSource: "inherited" });
  });

  it("uses the configured default for a visible picker but fails closed headless or no-picker", () => {
    const interactive = parseArgs([]);
    const body = freshSuBootstrapBody(
      { agent: "codex", workspace: "papercusp-workspace", harness: null, plan: null },
      interactive,
    );

    expect(body).toMatchObject({
      model: CODEX_SAFE_DEFAULT_MODEL,
      model_source: "configured-default",
    });
    expect(body.launch_argv).toEqual(
      expect.arrayContaining([
        `--model=${CODEX_SAFE_DEFAULT_MODEL}`,
        "--model-source=configured-default",
      ]),
    );
    expect(() => modelArgsFor("codex", null)).toThrow(/Codex model is required/);
    expect(() => parseArgs(["--headless", "--agent=codex"])).toThrow(/Codex model is required/);
    expect(() => parseArgs(["--no-picker", "--agent=codex"])).toThrow(/Codex model is required/);
    const authorizedHeadless = parseArgs([
      "--headless",
      "--agent=codex",
      "--model-source=configured-default",
    ]);
    expect(authorizedHeadless).toMatchObject({
      model: CODEX_SAFE_DEFAULT_MODEL,
      modelSource: "configured-default",
    });
    expect(
      freshSuBootstrapBody(
        { agent: "codex", workspace: "papercusp-workspace", harness: null, plan: null },
        authorizedHeadless,
      ),
    ).toMatchObject({ headless: true, model_source: "configured-default" });
    expect(
      parseArgs([
        "--no-picker",
        "--agent=codex",
        "--model-source=configured-default",
      ]),
    ).toMatchObject({
      picker: false,
      model: CODEX_SAFE_DEFAULT_MODEL,
      modelSource: "configured-default",
    });
  });
});

describe("scriptedOmpSetupEnv (headless OMP kickoff reaches the composer)", () => {
  it("skips first-run setup for scripted OMP sessions", () => {
    expect(
      scriptedOmpSetupEnv("omp", parseArgs(["--no-picker", "--agent=omp"]), {}),
    ).toEqual({
      OMP_SKIP_SETUP: "1",
    });
  });

  it("keeps the setup wizard for interactive OMP and every non-OMP backend", () => {
    expect(scriptedOmpSetupEnv("omp", parseArgs(["--agent=omp"]), {})).toEqual(
      {},
    );
    expect(
      scriptedOmpSetupEnv(
        "claude",
        parseArgs(["--no-picker", "--agent=claude"]),
        {},
      ),
    ).toEqual({});
    expect(
      scriptedOmpSetupEnv(
        "codex",
        parseArgs([
          "--no-picker",
          "--agent=codex",
          "--model=gpt-5.6-sol:xhigh",
          "--model-source=explicit",
        ]),
        {},
      ),
    ).toEqual({});
  });

  it("preserves an explicit OMP_SKIP_SETUP override", () => {
    expect(
      scriptedOmpSetupEnv("omp", parseArgs(["--no-picker", "--agent=omp"]), {
        OMP_SKIP_SETUP: "0",
      }),
    ).toEqual({});
  });
});

describe("requireOmpRoleMcpJsonPath (role bootstrap contract)", () => {
  it("returns the signed config path unchanged", () => {
    expect(requireOmpRoleMcpJsonPath({
      agent: "omp",
      role: "judge",
      mcpJsonPath: "/tmp/role-judge/.mcp.json",
    })).toBe("/tmp/role-judge/.mcp.json");
  });

  it("fails with an actionable contract error when bootstrap omits the path", () => {
    expect(() => requireOmpRoleMcpJsonPath({ agent: "omp", role: "judge" })).toThrow(
      "psu: bootstrap-role omitted the signed MCP config path for omp role 'judge'; refusing to launch without the role-scoped MCP config",
    );
  });
});

describe("finalizeFreshSuArgs (fresh SU kickoff reaches the backend)", () => {
  const KICK = "Begin: pull one admitted non-P2P bug.";

  it("keeps every backend launch argv prompt-free and returns the tagged managed-pty kickoff", () => {
    const provenanceDir = mkdtempSync(
      join(tmpdir(), "su-native-kickoff-prov-"),
    );
    try {
      for (const backend of ["claude", "codex", "omp"]) {
        const args = parseArgs([
          "--no-picker",
          `--agent=${backend}`,
          ...(backend === "codex"
            ? ["--model=gpt-5.6-sol:xhigh", "--model-source=explicit"]
            : []),
        ]);
        const result = finalizeFreshSuArgs(
          backend,
          ["--flag=value"],
          { envelopeEnv: { PAPERCUSP_SID: `${backend}-fresh-1` } },
          args,
          {
            PAPERCUSP_KICKOFF_PROMPT: KICK,
            PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
          },
        );

        expect(result.kickoffSeeded).toBe(true);
        expect(result.kickoff).toMatch(
          /^⟦turn-origin:fleet-kickoff nonce:[a-f0-9]{16}⟧\nBegin: pull one admitted non-P2P bug\.$/,
        );
        expect(result.args).toEqual(["--flag=value"]);
      }
    } finally {
      rmSync(provenanceDir, { recursive: true, force: true });
    }
  });

  it("keeps OMP argv unchanged and returns its managed-pty kickoff", () => {
    const provenanceDir = mkdtempSync(join(tmpdir(), "su-omp-kickoff-prov-"));
    try {
      const result = finalizeFreshSuArgs(
        "omp",
        ["--extension", "/tmp/coord-hook.ts"],
        { envelopeEnv: { PAPERCUSP_SID: "omp-fresh-1" } },
        parseArgs(["--no-picker", "--agent=omp"]),
        {
          PAPERCUSP_KICKOFF_PROMPT: KICK,
          PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
        },
      );

      expect(result.args).toEqual(["--extension", "/tmp/coord-hook.ts"]);
      expect(result.kickoffSeeded).toBe(true);
      expect(result.kickoff).toMatch(
        /^⟦turn-origin:fleet-kickoff nonce:[a-f0-9]{16}⟧\nBegin: pull one admitted non-P2P bug\.$/,
      );
    } finally {
      rmSync(provenanceDir, { recursive: true, force: true });
    }
  });
});

// resolveKickoffText — the SPAWN-SAFE env fallback the desktop docs-agent launcher
// relies on (a free-form question rides PAPERCUSP_KICKOFF_PROMPT, not a --kickoff arg,
// so it survives buildConsoleOneliner's greeting escaping instead of breaking the shell).
describe("resolveKickoffText (PAPERCUSP_KICKOFF_PROMPT env fallback)", () => {
  it("consumes a large file-backed kickoff once and clears the inherited pointer", () => {
    const text = "Full review: quotes '$' and Unicode ☎\n".repeat(6000);
    const env = prepareKickoffEnvironment({ PAPERCUSP_KICKOFF_PROMPT: text });
    const path = env[KICKOFF_PROMPT_FILE_ENV];
    const args = parseArgs(["--no-picker", "--agent=claude"]);
    expect(resolveKickoffText(args, env)).toBe(text);
    expect(env[KICKOFF_PROMPT_FILE_ENV]).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(resolveKickoffText(args, env)).toBeNull();
  });
  it("falls back to PAPERCUSP_KICKOFF_PROMPT when no --kickoff flag was parsed", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--label=docs-tutor",
    ]);
    expect(args.kickoffPromptText).toBeNull();
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PAPERCUSP_KICKOFF_PROMPT: "what's a pot?\nline two",
    };
    expect(resolveKickoffText(args, env)).toBe("what's a pot?\nline two");
    // and it actually seeds the first turn once threaded through kickoffPositionalArgs
    expect(
      kickoffPositionalArgs(
        {},
        { ...args, kickoffPromptText: resolveKickoffText(args, env) },
      ),
    ).toEqual(["what's a pot?\nline two"]);
  });
  it("an explicit --kickoff flag wins over the env var", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--kickoff=flag wins",
    ]);
    expect(
      resolveKickoffText(args, {
        NODE_ENV: "test",
        PAPERCUSP_KICKOFF_PROMPT: "env loses",
      }),
    ).toBe("flag wins");
  });
  it("returns null when neither the flag nor the env var is set", () => {
    const args = parseArgs(["--no-picker", "--agent=claude"]);
    expect(resolveKickoffText(args, { NODE_ENV: "test" })).toBeNull();
  });
});

// resumeKickoffText — the RESUME/FORK first turn (agent-launch-resume-primitives
// P-011/D-008). A resumed session has no positional-prompt seam and is unreachable
// through the roster (its presence rows were reaped at death), so this text is handed
// to the managed-pty host, which injects it once the child settles at its prompt.
describe("resumeKickoffText (P-011: the first turn of a scripted resume/fork)", () => {
  it("takes the --kickoff flag on a scripted resume", () => {
    const args = parseArgs([
      "--no-picker",
      "--resume=sid-1",
      "--account=default",
      "--kickoff=carry on",
    ]);
    expect(resumeKickoffText(args, { NODE_ENV: "test" })).toBe("carry on");
  });

  it("takes the spawn-safe PAPERCUSP_KICKOFF_PROMPT env when no flag was passed", () => {
    const args = parseArgs(["--no-picker", "--resume=sid-1"]);
    expect(
      resumeKickoffText(args, {
        NODE_ENV: "test",
        PAPERCUSP_KICKOFF_PROMPT: "multi\nline brief",
      }),
    ).toBe("multi\nline brief");
  });

  it("does NOT seed an interactive (picker) resume — a human opens at an empty prompt", () => {
    const args = parseArgs(["--resume=sid-1", "--kickoff=q"]);
    expect(resumeKickoffText(args, { NODE_ENV: "test" })).toBeNull();
  });

  it("honors --no-kickoff", () => {
    const args = parseArgs([
      "--no-picker",
      "--resume=sid-1",
      "--kickoff=q",
      "--no-kickoff",
    ]);
    expect(resumeKickoffText(args, { NODE_ENV: "test" })).toBeNull();
  });

  it("is null when nothing asked for a kickoff (a resume opens idle, as before)", () => {
    expect(
      resumeKickoffText(parseArgs(["--no-picker", "--resume=sid-1"]), {
        NODE_ENV: "test",
      }),
    ).toBeNull();
  });

  it("never falls back to a server plan kickoff — a resume does no bootstrap POST", () => {
    // kickoffPositionalArgs' res.kickoffPrompt leg must not leak into the resume path.
    const planKickoff = "Begin: advance this plan";
    const args = parseArgs(["--no-picker", "--resume=sid-1"]);
    expect(resumeKickoffText(args, { NODE_ENV: "test" })).toBeNull();
    expect(
      kickoffPositionalArgs(
        { kickoffPrompt: planKickoff, planSlug: "p" },
        args,
      ),
    ).toEqual([planKickoff]);
  });
});

describe("parkRoleScopedMcpJson (P-002 / EI-10388 SU co-located-.mcp.json leak guard)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "psu-park-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const mcp = () => join(dir, ".mcp.json");
  const parked = () => join(dir, ".mcp.json.su-parked");

  it("parks a role-scoped .mcp.json (signed role= URL) and removes the original", () => {
    writeFileSync(
      mcp(),
      JSON.stringify({
        mcpServers: {
          papercusp: {
            type: "http",
            url: "http://127.0.0.1:9071/api/mcp?workspace=ws&role=planner&sig=abc&exp=1",
          },
        },
      }),
    );
    expect(parkRoleScopedMcpJson(dir)).toBe(parked());
    expect(existsSync(mcp())).toBe(false);
    expect(existsSync(parked())).toBe(true);
  });

  // EI-10388 (2026-07-12): a superuser-scoped co-located .mcp.json is now ALSO parked, not
  // exempted. The prior exemption assumed a superuser=1 project file always IS the current
  // papercusp-su server — false for a stale one under a DIFFERENT server name ("papercusp",
  // not "papercusp-su") with no `tools=` seed: OMP discovered it ALONGSIDE the correctly
  // seeded per-session "papercusp-su" server and merged both catalogs (~39 seeded + ~740
  // unfiltered = ~778 tools, hard 400 on a small-context local model). An SU launch never
  // needs a co-located .mcp.json at all (user-level / per-session config covers it), so any
  // shape is parked unconditionally.
  it('parks a superuser-scoped .mcp.json too (EI-10388 — a stale "papercusp" server merges its full catalog onto the seeded "papercusp-su" one)', () => {
    writeFileSync(
      mcp(),
      JSON.stringify({
        mcpServers: {
          "papercusp-su": {
            type: "http",
            url: "http://localhost:3070/api/mcp?superuser=1&client=x",
          },
        },
      }),
    );
    expect(parkRoleScopedMcpJson(dir)).toBe(parked());
    expect(existsSync(mcp())).toBe(false);
    expect(existsSync(parked())).toBe(true);
  });

  it("no-op when there is no .mcp.json", () => {
    expect(parkRoleScopedMcpJson(dir)).toBe(null);
  });

  it("overwrites a stale prior park instead of failing", () => {
    writeFileSync(parked(), "STALE");
    writeFileSync(
      mcp(),
      JSON.stringify({
        mcpServers: { p: { url: "http://h/api/mcp?role=sentinel&sig=z" } },
      }),
    );
    expect(parkRoleScopedMcpJson(dir)).toBe(parked());
    expect(existsSync(mcp())).toBe(false);
  });

  // EI-10388: classification by content is gone — ANY existing .mcp.json is parked
  // unconditionally, including one we can't even parse (it was never safely usable anyway).
  it("parks an unparseable .mcp.json too (never throws)", () => {
    writeFileSync(mcp(), "not json{");
    expect(parkRoleScopedMcpJson(dir)).toBe(parked());
    expect(existsSync(mcp())).toBe(false);
    expect(existsSync(parked())).toBe(true);
  });
});

describe("resolveOmpSessionModel (structured account fidelity)", () => {
  it("rejects an inherited retired or gateway default before per-session materialization", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-omp-model-route-"));
    try {
      const agent = join(home, ".omp", "agent");
      mkdirSync(agent, { recursive: true });
      for (const model of ["openrouter/stealth/ox-alpha", "papercusp-gateway/claude-sonnet-4-6"]) {
        const config = `modelRoles:\n  default: ${model}\n`;
        writeFileSync(join(agent, "config.yml"), config);
        expect(() => resolveOmpSessionModel(null, "default", home)).toThrow(/retired|default.*gateway/i);
        expect(readFileSync(join(agent, "config.yml"), "utf8")).toBe(config);
        expect(existsSync(join(home, ".papercusp", "su-omp-homes"))).toBe(false);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each(["auto", "named-account"])("preserves a selected gateway model for %s", (route) => {
    expect(resolveOmpSessionModel("papercusp-gateway/claude-opus-4-8:high", route))
      .toBe("papercusp-gateway/claude-opus-4-8:high");
  });

  it("preserves a selected direct model and rejects an explicit retired model", () => {
    expect(resolveOmpSessionModel("openai-codex/gpt-5.6-terra:xhigh", "default"))
      .toBe("openai-codex/gpt-5.6-terra:xhigh");
    expect(() => resolveOmpSessionModel("stealth/ox-alpha:max", "auto")).toThrow(/retired/);
    expect(() => resolveOmpSessionModel("papercusp-gateway/claude-sonnet-4-6", "default"))
      .toThrow(/default.*gateway/i);
  });
});

describe("ompDefaultModelAdvisory (P-004 first-turn overflow guard)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-cfg-"));
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const writeCfg = (s: string) =>
    writeFileSync(join(home, ".omp", "agent", "config.yml"), s);

  it("advises when the default role is a local ollama model", () => {
    writeCfg(
      "modelRoles:\n  default: ollama/ornith:fast\n  slow: anthropic/claude-opus-4-6:high\n",
    );
    expect(ompDefaultModelAdvisory(home)).toMatch(/ollama\/ornith:fast/);
  });
  it("no advisory when the default is a gateway/anthropic model", () => {
    writeCfg("modelRoles:\n  default: papercusp-gateway/claude-sonnet-4-6\n");
    expect(ompDefaultModelAdvisory(home)).toBe(null);
  });
  it("no advisory when config.yml is absent", () => {
    rmSync(join(home, ".omp", "agent", "config.yml"), { force: true });
    expect(ompDefaultModelAdvisory(home)).toBe(null);
  });
});

describe("SU_CONTEXT_CHOICES (trimmed-only launch policy)", () => {
  it("offers exactly the growable trimmed mode", () => {
    expect(SU_CONTEXT_CHOICES.map((c) => c.value)).toEqual(["trimmed"]);
  });

  // PSU_-prefixed alias throughout: this describe tests psu-launcher.mjs's OWN
  // terminal picker, so it must assert against the LAUNCHER's constants. The bare
  // names belong to the operator-core TS twins (imported below for the WI-6321
  // parity suite) and reading them here tested the wrong module — see the note on
  // the import block.
  it("labels embed the token estimates, in parity with the operator UI", () => {
    const trimmed = SU_CONTEXT_CHOICES.find((c) => c.value === "trimmed")!;
    expect(trimmed.name).toContain(PSU_SU_CONTEXT_TOKEN_ESTIMATES.trimmed);
    // Same measured figures the UI's SU_CONTEXT_OPTIONS shows (AdvSessionsClient.tsx),
    // which is ALSO single-key — that is what makes this parity rather than a claim of it.
    // Re-measured 2026-07-02 post-Phase-3: 60.1k sonnet-fleet / ~76k power boot
    // (the P-018 '~83k' was pre-Phase-3, full persona).
    //
    // trimmed-only-agent-context-launch: this assertion is EXACT (toEqual, not
    // toMatchObject) on purpose — a resurrected 'full' key here would mean the retired
    // whole-catalog mode had been re-advertised in the picker label source, so this fails
    // rather than tolerating it. Until 2026-08-27 it asserted the opposite, PINNING
    // full:'~180k' in place so that removing the residue required editing a green test.
    expect(PSU_SU_CONTEXT_TOKEN_ESTIMATES).toEqual({
      trimmed: "~70k",
    });
  });

  it("picker values are a subset of the --context-size flag values parseArgs accepts", () => {
    // Guards drift between the interactive picker and the flag path: every non-null
    // picker value must be a value parseArgs(--context-size=…) yields.
    for (const c of SU_CONTEXT_CHOICES) {
      if (c.value === null) continue;
      expect(parseArgs([`--context-size=${c.value}`]).contextSize).toBe(
        c.value,
      );
    }
  });

  it("defaults the picker selection to Trimmed", () => {
    // The tool catalogue the picker highlights by default: neither the full
    // up-front catalog nor each client's native (no-flag) behavior, but the
    // trimmed core-spine + native-soft-trim variant.
    expect(PSU_SU_CONTEXT_DEFAULT).toBe("trimmed");
    expect(
      SU_CONTEXT_CHOICES.some((c) => c.value === PSU_SU_CONTEXT_DEFAULT),
    ).toBe(true);
    const defaultChoice = SU_CONTEXT_CHOICES.find(
      (c) => c.value === PSU_SU_CONTEXT_DEFAULT,
    )!;
    expect(defaultChoice.name).toMatch(/trimmed/i);
    expect(defaultChoice.name).toMatch(/default/i);
  });
});

describe("native OMP capability selection", () => {
  const env = { PAPERCUSP_MCP_TRANSPORT: "uds" };

  it("prefers a complete packaged-adjacent asset pair and falls back atomically to source assets", () => {
    const root = mkdtempSync(join(tmpdir(), "psu-native-mcp-assets-"));
    try {
      const launcher = join(root, "apps", "operator", "scripts", "psu.mjs");
      const adjacentDir = join(root, "apps", "operator", "scripts");
      const sourceDir = join(root, "packages", "omp-plugin", "dist");
      mkdirSync(adjacentDir, { recursive: true });
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, "native-client.cjs"), "source client");
      writeFileSync(join(sourceDir, "native-extension.mjs"), "source extension");

      const resolvedPaths = () => {
        const assets = resolveNativeMcpAssets(pathToFileURL(launcher));
        return {
          bundle: fileURLToPath(assets.bundle),
          extension: fileURLToPath(assets.extension),
        };
      };

      expect(resolvedPaths()).toEqual({
        bundle: join(sourceDir, "native-client.cjs"),
        extension: join(sourceDir, "native-extension.mjs"),
      });

      writeFileSync(join(adjacentDir, "native-client.cjs"), "packaged client");
      // A partial packaged layout must not mix asset generations.
      expect(resolvedPaths()).toEqual({
        bundle: join(sourceDir, "native-client.cjs"),
        extension: join(sourceDir, "native-extension.mjs"),
      });

      writeFileSync(join(adjacentDir, "native-extension.mjs"), "packaged extension");
      expect(resolvedPaths()).toEqual({
        bundle: join(adjacentDir, "native-client.cjs"),
        extension: join(adjacentDir, "native-extension.mjs"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads an owned extension only for compatible OMP, never changes engines or emits unix URLs", () => {
    const args = nativeOmpExtensionArgs("omp", env, "linux", () => true);
    expect(args[0]).toBe("-e");
    expect(args[1]).toMatch(/omp-plugin\/dist\/native-extension\.mjs$/);
    expect(args.join(" ")).not.toContain("unix://");
    for (const backend of ["claude", "codex"]) {
      expect(nativeOmpExtensionArgs(backend, env, "linux", () => true)).toEqual([]);
    }
    expect(nativeOmpExtensionArgs("omp", {}, "linux", () => true)).toEqual([]);
    expect(nativeOmpExtensionArgs("omp", env, "win32", () => true)).toEqual([]);
    expect(nativeOmpExtensionArgs("omp", { ...env, WSL_INTEROP: "1" }, "linux", () => true)).toEqual([]);
    expect(() => nativeOmpExtensionArgs("omp", env, "linux", () => false)).toThrow("bundle missing");
  });
});

describe("writeOmpSessionConfigDir (WI-1282 + weak-model-tool-tier — OMP per-session config)", () => {
  let home: string;
  const AGENT_CFG = [
    "agent:",
    "  discoveryMode: mcp-only",
    "tools:",
    "  discoveryMode: true",
    "modelRoles:",
    "  default: papercusp-gateway/claude-sonnet-4-6",
    "",
  ].join("\n");
  const MCP_JSON = JSON.stringify({
    mcpServers: {
      "papercusp-su": {
        type: "http",
        url: "http://localhost:3070/api/mcp?superuser=1&client=abc",
        headers: { Authorization: "Bearer SECRET" },
      },
    },
  });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-ompcfg-"));
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "config.yml"), AGENT_CFG);
    writeFileSync(
      join(home, ".omp", "agent", "auth.json"),
      '{"token":"AUTHSECRET"}',
    );
    writeFileSync(
      join(home, ".omp", "agent", "models.yml"),
      "providers:\n  ollama:\n    baseUrl: http://127.0.0.1:11435/v1\n",
    );
    writeFileSync(join(home, ".omp", "agent", "models.db"), "BINARYREGISTRY");
    writeFileSync(join(home, ".omp", "agent", "mcp.json"), MCP_JSON);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // ⚠ HOME-RELATIVE — OMP joins PI_CONFIG_DIR onto homedir(); an absolute value would double.
  const relDir = (id: string) =>
    join(".papercusp", "su-omp-homes", `session-${id}`);
  const agentPath = (id: string, f: string) =>
    join(home, relDir(id), "agent", f);

  it("returns a HOME-RELATIVE path (not absolute — OMP joins PI_CONFIG_DIR onto $HOME)", () => {
    const dir = writeOmpSessionConfigDir("sess1", {}, home);
    expect(dir).toBe(relDir("sess1"));
    expect(dir!.startsWith("/")).toBe(false); // relative, so join(home, dir) resolves correctly
  });

  it("isolates OMP writes and resumes under the configured session root", () => {
    const root = join(home, 'isolated-omp');
    vi.stubEnv('PAPERCUSP_SU_OMP_HOMES_DIR', root);
    try {
      const dir = writeOmpSessionConfigDir('isolated', {}, home);
      const agentHome = join(root, 'session-isolated', 'agent');
      expect(join(home, dir!, 'agent')).toBe(agentHome);
      expect(existsSync(join(agentHome, 'config.yml'))).toBe(true);
      expect(existsSync(join(home, relDir('isolated')))).toBe(false);
      expect(ompTrackedResumeEnv({ agent: 'omp', id: 'isolated' }, { home })).toEqual({
        PI_CONFIG_DIR: dir, PI_CODING_AGENT_DIR: agentHome,
        PAPERCUSP_MCP_TRANSPORT: "http",
      });
    } finally { vi.unstubAllEnvs(); }
  });

  it("writes signed role MCP contents verbatim even without a models registry override", () => {
    const roleMcp = JSON.stringify({
      mcpServers: {
        papercusp: {
          type: "http",
          url: "http://localhost:3070/api/mcp?role=worker&client=role-abc&sig=signed",
        },
      },
    });
    const dir = writeOmpSessionConfigDir(
      "role-isolated",
      { mcpJsonContents: roleMcp, modelsYml: null },
      home,
    );
    expect(readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8")).toBe(
      roleMcp,
    );
  });

  // WI-10003604: the in-process PUI engine re-points the origin straight at the operator,
  // bypassing the :9071 proxy that refreshes the bearer. The template's minted bearer
  // ("SECRET") then reaches an operator validating a different token.
  it("writes the operator's live bearer, not the template's, when the origin is re-pointed", () => {
    const dir = writeOmpSessionConfigDir(
      "bearer",
      { operatorUrl: "http://localhost:38931", operatorBearer: "LIVE-TOKEN-0123456789" },
      home,
    );
    const su = JSON.parse(readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"))
      .mcpServers["papercusp-su"];
    expect(new URL(su.url).origin).toBe("http://localhost:38931");
    expect(su.headers.Authorization).toBe("Bearer LIVE-TOKEN-0123456789");
    // The user's global template is a SOURCE: it is never rewritten.
    expect(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf8")).toBe(MCP_JSON);
  });

  it("keeps the template bearer when no operator bearer is supplied", () => {
    const dir = writeOmpSessionConfigDir("nobearer", { operatorBearer: null }, home);
    const su = JSON.parse(readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"))
      .mcpServers["papercusp-su"];
    expect(su.headers.Authorization).toBe("Bearer SECRET");
  });

  it("never rewrites the bearer inside signed role MCP bytes", () => {
    const roleMcp = JSON.stringify({
      mcpServers: {
        "papercusp-role": {
          type: "http",
          url: "http://localhost:3070/api/mcp?superuser=1&role=reviewer&sig=abc",
          headers: { Authorization: "Bearer ROLE" },
        },
      },
    });
    const dir = writeOmpSessionConfigDir(
      "role-bearer",
      { mcpJsonContents: roleMcp, operatorBearer: "LIVE-TOKEN-0123456789" },
      home,
    );
    expect(readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8")).toBe(roleMcp);
  });

  it.each(["uds", "auto"])("preserves %s and authoritative SU identity through a new-shell resume", (mode) => {
    vi.stubEnv("PAPERCUSP_MCP_TRANSPORT", mode);
    vi.stubEnv("WSL_INTEROP", "");
    vi.stubEnv("WSL_DISTRO_NAME", "");
    vi.stubEnv("PAPERCUSP_IPC_TCP", "");
    vi.stubEnv("PAPERCUSP_SID", "su-stale-parent");
    vi.stubEnv("PAPERCUSP_WORKSPACE", "stale-parent-workspace");
    vi.stubEnv("PAPERCUSP_PROFILE", "stale-parent-profile");
    try {
      const source = {
        mcpServers: {
          "papercusp-su": {
            type: "http",
            url: "http://localhost:3070/api/mcp?superuser=1&client=machine",
            headers: {
              Authorization: "Bearer FIXTURE",
              "x-papercusp-client": '!printf %s "${PAPERCUSP_SID:-}"',
              "x-papercusp-workspace": '!printf %s "${PAPERCUSP_WORKSPACE:-}"',
              "x-papercusp-profile": '!printf %s "${PAPERCUSP_PROFILE:-}"',
            },
          },
        },
      };
      writeFileSync(join(home, ".omp", "agent", "mcp.json"), JSON.stringify(source));
      const mcpEnv = {
        PAPERCUSP_SID: "su-current",
        PAPERCUSP_WORKSPACE: "current-workspace",
        PAPERCUSP_PROFILE: "current-profile",
      };
      const dir = writeOmpSessionConfigDir("native", {
        nativeMcp: true, clientId: "su-current", mcpEnv,
      }, home);
      const saved = JSON.parse(readFileSync(agentPath("native", "mcp.json"), "utf8"));
      expect(saved.mcpServers).toEqual({});
      expect(saved.papercuspNativeMcp).toMatchObject({ version: 1, mode, home });
      const server = saved.papercuspNativeMcp.servers["papercusp-su"];
      expect(new URL(server.url).searchParams.get("client")).toBe("su-current");
      expect(server.headers).toEqual({
        Authorization: "Bearer FIXTURE",
        "x-papercusp-client": "su-current",
        "x-papercusp-workspace": "current-workspace",
        "x-papercusp-profile": "current-profile",
      });
      expect(statSync(agentPath("native", "mcp.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf8"))).toEqual(source);

      // A new shell no longer exports the opt-in. The saved config, not this
      // ambient default, must drive the actual argv or its moved tools vanish.
      vi.stubEnv("PAPERCUSP_MCP_TRANSPORT", "");
      const session = { agent: "omp", role: "su", id: "native", ompThreadId: "original-thread" };
      const env = ompTrackedResumeEnv(session, { home });
      expect(env).toMatchObject({
        PI_CONFIG_DIR: dir, PI_CODING_AGENT_DIR: agentPath("native", ""),
        PAPERCUSP_MCP_TRANSPORT: mode,
      });
      const resumed = resumeArgsFor(session, { env });
      expect(resumed.bin).toBe("omp");
      expect(resumed.args.slice(0, 2)).toEqual(["-r", "original-thread"]);
      expect(resumed.args).toEqual(expect.arrayContaining(nativeOmpExtensionArgs("omp", env)));
      expect(resumed.args.join(" ")).toContain("native-extension.mjs");
      // A role must never gain the user SU adapter even with a native env.
      expect(resumeArgsFor({ ...session, role: "reviewer" }, { env }).args.join(" "))
        .not.toContain("native-extension.mjs");
      expect(() => ompTrackedResumeEnv({ ...session, role: "reviewer" }, { home }))
        .toThrow("role-scoped resume");
    } finally { vi.unstubAllEnvs(); }
  });

  it("leaves role and unsupported remote entries on their existing HTTP client", () => {
    vi.stubEnv("PAPERCUSP_MCP_TRANSPORT", "uds");
    try {
      writeOmpSessionConfigDir("role", { clientId: "role-current" }, home);
      const role = JSON.parse(readFileSync(agentPath("role", "mcp.json"), "utf8"));
      expect(role.papercuspNativeMcp).toBeUndefined();
      expect(role.mcpServers["papercusp-su"].type).toBe("http");
      const remote = { mcpServers: {
        remote: { type: "http", url: "https://remote.example/api/mcp" },
      } };
      writeFileSync(join(home, ".omp", "agent", "mcp.json"), JSON.stringify(remote));
      writeOmpSessionConfigDir("remote", {
        nativeMcp: true, operatorUrl: "https://remote.example",
      }, home);
      const saved = JSON.parse(readFileSync(agentPath("remote", "mcp.json"), "utf8"));
      expect(saved.papercuspNativeMcp).toBeUndefined();
      expect(new URL(saved.mcpServers.remote.url).origin).toBe("https://remote.example");
    } finally { vi.unstubAllEnvs(); }
  });

  it("does not adopt a parent native transport when resuming a saved HTTP profile", () => {
    writeOmpSessionConfigDir("http", {}, home);
    vi.stubEnv("PAPERCUSP_MCP_TRANSPORT", "uds");
    try {
      const session = { agent: "omp", role: "su", id: "http", ompThreadId: "http-thread" };
      const env = ompTrackedResumeEnv(session, { home });
      expect(env.PAPERCUSP_MCP_TRANSPORT).toBe("http");
      expect(resumeArgsFor(session, { env }).args.join(" ")).not.toContain("native-extension.mjs");
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    "{",
    JSON.stringify({ papercuspNativeMcp: { version: 2, mode: "uds", servers: { fixture: {} } } }),
    JSON.stringify({ papercuspNativeMcp: { version: 1, mode: "stdio", servers: { fixture: {} } } }),
    JSON.stringify({ papercuspNativeMcp: { version: 1, mode: "uds", servers: {} } }),
  ])("rejects an unreadable or incompatible saved MCP profile instead of losing its tools: %s", (config) => {
    writeOmpSessionConfigDir("invalid", {}, home);
    writeFileSync(agentPath("invalid", "mcp.json"), config);
    expect(() => ompTrackedResumeEnv({ agent: "omp", role: "su", id: "invalid" }, { home }))
      .toThrow("refusing an incomplete resume");
  });

  // NOT "full mode": discoveryOff accompanies the trimmed SEED and is explicitly not
  // the retired whole-catalog mode (see the discoveryOff doc on writeOmpSessionConfigDir).
  it("discoveryOff flips discoveryMode OFF, preserving modelRoles", () => {
    const dir = writeOmpSessionConfigDir("sess1", { discoveryOff: true }, home);
    const written = readFileSync(
      join(home, dir!, "agent", "config.yml"),
      "utf8",
    );
    expect(written).toContain("discoveryMode: off");
    expect(written).toContain("discoveryMode: false");
    expect(written).not.toContain("discoveryMode: mcp-only");
    expect(written).toContain("default: papercusp-gateway/claude-sonnet-4-6");
  });

  it("default (no opts) leaves discovery untouched (config copied, eval-off block appended)", () => {
    writeOmpSessionConfigDir("sess1", {}, home);
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toContain("discoveryMode: mcp-only"); // unchanged
    expect(written).toContain("discoveryMode: true");
  });

  it("disables the eval builtin (py/js/rb/jl → false) in the per-session config (WI-2382 scoping fix)", () => {
    // AGENT_CFG has NO eval: block — the surgery must APPEND a canonical all-off one so the weak
    // local model can never doom-loop on eval. This replaces the former GLOBAL omp-config disable.
    writeOmpSessionConfigDir("sess1", {}, home);
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toContain("eval:");
    for (const lang of ["py", "js", "rb", "jl"]) {
      expect(written).toMatch(new RegExp(`\\n\\s+${lang}:\\s*false`));
    }
  });

  it("does NOT mutate the user’s global ~/.omp config (eval stays as the user set it)", () => {
    // The scoping guarantee the owner asked for: a user’s own DIRECT (non-psu) omp keeps eval.
    writeOmpSessionConfigDir("sess1", {}, home);
    const globalCfg = readFileSync(
      join(home, ".omp", "agent", "config.yml"),
      "utf8",
    );
    expect(globalCfg).toBe(AGENT_CFG); // untouched — no eval: block injected into the global
    expect(globalCfg).not.toContain("eval:");
  });

  it("FLIPS an inherited eval:on block to off (remove-then-append, no duplicate key)", () => {
    // A user who had eval ENABLED globally: the copy must still come out disabled, exactly once.
    const withEval =
      AGENT_CFG + "eval:\n  py: true\n  js: true\n  rb: true\n  jl: true\n";
    writeFileSync(join(home, ".omp", "agent", "config.yml"), withEval);
    writeOmpSessionConfigDir("sess1", {}, home);
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect((written.match(/^eval:/gm) ?? []).length).toBe(1); // exactly one eval: block
    expect(written).not.toMatch(/\n\s+py:\s*true/); // no leftover on-value
    expect(written).toMatch(/\n\s+py:\s*false/);
  });

  it("rewrites a RETIRED global modelRoles.default (openrouter/stealth/ox-alpha) to the explicit --model this launch selected (EI-21919040934117285)", () => {
    writeFileSync(
      join(home, ".omp", "agent", "config.yml"),
      AGENT_CFG.replace(
        "default: papercusp-gateway/claude-sonnet-4-6",
        "default: openrouter/stealth/ox-alpha",
      ),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeOmpSessionConfigDir("sess1", { model: "ollama/ornith" }, home);
    const errMsgs = err.mock.calls.map((c) => String(c[0]));
    err.mockRestore();
    expect(errMsgs.some((m) => m.includes("CONFIG ERROR"))).toBe(true);
    expect(
      errMsgs.some((m) => m.includes("openrouter/stealth/ox-alpha")),
    ).toBe(true);
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toContain("default: ollama/ornith");
    expect(written).not.toContain("ox-alpha");
  });

  it("rewrites a RETIRED global modelRoles.default to the gateway fallback when no explicit --model is passed (EI-21919040934117285)", () => {
    writeFileSync(
      join(home, ".omp", "agent", "config.yml"),
      AGENT_CFG.replace(
        "default: papercusp-gateway/claude-sonnet-4-6",
        "default: stealth/ox-alpha:xhigh",
      ),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeOmpSessionConfigDir("sess1", {}, home);
    err.mockRestore();
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toContain("default: papercusp-gateway/claude-sonnet-4-6");
    expect(written).not.toContain("ox-alpha");
  });

  it("leaves a NON-retired modelRoles.default untouched, byte-for-byte", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeOmpSessionConfigDir("sess1", {}, home);
    err.mockRestore();
    expect(
      err.mock.calls.some((c) => String(c[0]).includes("CONFIG ERROR")),
    ).toBe(false);
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toContain("default: papercusp-gateway/claude-sonnet-4-6");
  });

  it("disables automatic provider retries for a LOCAL-model session and removes inherited retry policy (WI-5047)", () => {
    const withRetry =
      AGENT_CFG.replace(
        "papercusp-gateway/claude-sonnet-4-6",
        "ollama-cc/maxwell1500/ornith-35b:IQ3_M:xhigh",
      ) +
      "retry:\n  enabled: true\n  maxRetries: 10\n  modelFallback: true\n" +
      "retry.baseDelayMs: 123\n";
    writeFileSync(join(home, ".omp", "agent", "config.yml"), withRetry);
    writeOmpSessionConfigDir(
      "sess1",
      { model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M:xhigh" },
      home,
    );
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect((written.match(/^retry:/gm) ?? []).length).toBe(1);
    expect(written).toMatch(/^retry:\n\s+enabled:\s*false$/m);
    expect(written).not.toContain("maxRetries");
    expect(written).not.toContain("modelFallback");
    expect(written).not.toContain("retry.baseDelayMs");
  });

  it("preserves the inherited retry policy for a HOSTED-model session (WI-5047 scope guard)", () => {
    const withRetry =
      AGENT_CFG +
      "retry:\n  enabled: true\n  maxRetries: 7\n  modelFallback: true\n";
    writeFileSync(join(home, ".omp", "agent", "config.yml"), withRetry);
    writeOmpSessionConfigDir(
      "sess1",
      { model: "anthropic/claude-opus-4-8" },
      home,
    );
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect((written.match(/^retry:/gm) ?? []).length).toBe(1);
    expect(written).toMatch(
      /^retry:\n\s+enabled:\s*true\n\s+maxRetries:\s*7\n\s+modelFallback:\s*true$/m,
    );
    expect(written).not.toMatch(/^retry:\n\s+enabled:\s*false$/m);
  });

  it("seeds shake@70 compaction for a LOCAL-model session; no endpoint without an owner (P-001, P-022)", () => {
    // The ornith overflow (2026-07-13): default snapcompact + all-default thresholds on a
    // text-only 204K local window → image archives, summarizer 429 self-starvation, HTTP 400.
    // P-022: shake is mechanical (no LLM call), so a clientId-less session gets NO
    // remoteEndpoint — nothing would call it, and it would be the plain-LLM lane if it did.
    writeOmpSessionConfigDir(
      "sess1",
      { model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M" },
      home,
    );
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toMatch(/^compaction:$/m);
    expect(written).toMatch(/\n\s+strategy:\s*shake/);
    expect(written).toMatch(/\n\s+thresholdPercent:\s*70/);
    expect(written).not.toContain("remoteEndpoint");
  });

  it("P-022: EVERY hosted omp model gets the forced papercusp block — gateway-routed and direct alike (native strategies retired)", () => {
    writeOmpSessionConfigDir(
      "sess1",
      { model: "papercusp-gateway/claude-sonnet-4-6" },
      home,
    );
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toMatch(/^compaction:$/m);
    expect(written).toMatch(/\n\s+strategy:\s*shake/); // no clientId ⇒ mechanical
    expect(written).toMatch(/\n\s+thresholdPercent:\s*\d+/);
    expect(written).not.toContain("remoteEndpoint");
    // Direct (non-gateway) hosted model: same forced block — omp's native
    // strategies are retired everywhere, and shake introduces no gateway dependency.
    writeOmpSessionConfigDir(
      "sess2",
      { model: "anthropic/claude-opus-4-8" },
      home,
    );
    const direct = readFileSync(agentPath("sess2", "config.yml"), "utf8");
    expect(direct).toMatch(/^compaction:$/m);
    expect(direct).toMatch(/\n\s+strategy:\s*shake/);
  });

  it("remoteEndpoint injection PRESERVES an inherited compaction block for a gateway model (no duplicate keys)", () => {
    const withCompaction =
      AGENT_CFG +
      'compaction:\n  strategy: snapcompact\n  thresholdPercent: 90\n  remoteEndpoint: "http://old:1/x"\n';
    writeFileSync(join(home, ".omp", "agent", "config.yml"), withCompaction);
    writeOmpSessionConfigDir(
      "sess1",
      { model: "papercusp-gateway/claude-sonnet-4-6" },
      home,
    );
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    // P-022: the inherited native block is REPLACED wholesale, never merged — one
    // block, snapcompact and the stale endpoint both gone.
    expect((written.match(/^compaction:/gm) ?? []).length).toBe(1);
    expect(written).not.toContain("http://old:1/x");
    expect(written).not.toContain("snapcompact");
    expect(written).toMatch(/\n\s+strategy:\s*shake/); // no clientId ⇒ mechanical, no endpoint
    expect(written).not.toContain("remoteEndpoint");
  });

  it("remoteEndpoint honors PAPERCUSP_GATEWAY_PORT (launcher port rule, default 8788) — endpoint rides with a carry owner (P-022)", () => {
    const saved = process.env.PAPERCUSP_GATEWAY_PORT;
    try {
      process.env.PAPERCUSP_GATEWAY_PORT = "8797";
      writeOmpSessionConfigDir(
        "sess1",
        { model: "ollama/ornith", clientId: "su-port-1" },
        home,
      );
      expect(readFileSync(agentPath("sess1", "config.yml"), "utf8")).toContain(
        'remoteEndpoint: "http://127.0.0.1:8797/maintenance/summarize?carryOwner=su-port-1"',
      );
      delete process.env.PAPERCUSP_GATEWAY_PORT;
      writeOmpSessionConfigDir(
        "sess2",
        { model: "ollama/ornith", clientId: "su-port-2" },
        home,
      );
      expect(readFileSync(agentPath("sess2", "config.yml"), "utf8")).toContain(
        'remoteEndpoint: "http://127.0.0.1:8788/maintenance/summarize?carryOwner=su-port-2"',
      );
    } finally {
      if (saved === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
      else process.env.PAPERCUSP_GATEWAY_PORT = saved;
    }
  });

  it("carry opt-in appends ?carryOwner=<clientId>&carryWindow=<backendWindow> + flips the weak-model strategy to context-full (deterministic-context-carry P-017, WI-4845)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {}); // the informational door line
    writeOmpSessionConfigDir(
      "sess1",
      {
        model: "ollama/ornith",
        clientId: "su-carry-1",
        backendWindow: 204800,
        carryCompaction: true,
      },
      home,
    );
    err.mockRestore();
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toMatch(
      /\n\s+remoteEndpoint:\s*"http:\/\/127\.0\.0\.1:\d+\/maintenance\/summarize\?carryOwner=su-carry-1&carryWindow=204800"/,
    );
    // The mechanical shake never calls remoteEndpoint — an opted-in session must run an
    // LLM-capable strategy so the compaction actually reaches the gateway's carry branch.
    expect(written).toMatch(/\n\s+strategy:\s*context-full/);
    expect(written).not.toContain("strategy: shake");
    expect(written).toMatch(/\n\s+thresholdPercent:\s*\d+/); // threshold seeding unchanged
  });

  it("interactive:true appends &carryInteractive=1 so the gateway residual sampler gets the truthful bit (P-019, D-010)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeOmpSessionConfigDir(
      "sess1",
      {
        model: "ollama/ornith",
        clientId: "su-carry-i",
        backendWindow: 204800,
        carryCompaction: true,
        interactive: true,
      },
      home,
    );
    err.mockRestore();
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toContain(
      "/maintenance/summarize?carryOwner=su-carry-i&carryWindow=204800&carryInteractive=1",
    );
  });

  it("interactive defaults FALSE — a headless/piped launch omits carryInteractive (its boundaries are graded by P-020 drills, not sampled)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeOmpSessionConfigDir(
      "sess1",
      {
        model: "ollama/ornith",
        clientId: "su-carry-h",
        backendWindow: 204800,
        carryCompaction: true,
      },
      home,
    );
    err.mockRestore();
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toContain("carryOwner=su-carry-h");
    expect(written).not.toContain("carryInteractive");
  });

  it("no clientId ⇒ mechanical shake with NO endpoint line — no gateway hard-dependency, no plain-LLM lane (P-022)", () => {
    writeOmpSessionConfigDir(
      "sess1",
      { model: "ollama/ornith", carryCompaction: true },
      home,
    );
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).not.toContain("remoteEndpoint");
    expect(written).not.toContain("carryOwner");
    expect(written).toMatch(/\n\s+strategy:\s*shake/);
  });

  it("P-022: a gateway-routed hosted model gets the FORCED carry block too (context-full + carryOwner; no probed window ⇒ no carryWindow) — supersedes the P-001 preserve decision", () => {
    writeOmpSessionConfigDir(
      "sess1",
      {
        model: "papercusp-gateway/claude-sonnet-4-6",
        clientId: "su-carry-2",
        carryCompaction: true,
      },
      home,
    );
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toMatch(
      /\n\s+remoteEndpoint:\s*"http:\/\/127\.0\.0\.1:\d+\/maintenance\/summarize\?carryOwner=su-carry-2"/,
    );
    expect(written).not.toContain("carryWindow");
    expect(written).toMatch(/\n\s+strategy:\s*context-full/);
    expect(written).not.toContain("strategy: shake");
  });

  it("carry defaults ON for an owned session: params are present and weak-model strategy reaches the carry endpoint", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {}); // the informational door line
    writeOmpSessionConfigDir(
      "sess1",
      { model: "ollama/ornith", clientId: "su-carry-3", backendWindow: 204800 },
      home,
    );
    err.mockRestore();
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).toContain(
      "/maintenance/summarize?carryOwner=su-carry-3&carryWindow=204800",
    );
    expect(written).toMatch(/\n\s+strategy:\s*context-full/);
  });

  it("P-022: the old PAPERCUSP_OMP_CARRY_COMPACTION=0 opt-out is RETIRED — carry still applies with the env set", () => {
    const saved = process.env.PAPERCUSP_OMP_CARRY_COMPACTION;
    try {
      process.env.PAPERCUSP_OMP_CARRY_COMPACTION = "0";
      const err = vi.spyOn(console, "error").mockImplementation(() => {}); // the informational door line
      writeOmpSessionConfigDir(
        "sess1",
        {
          model: "ollama/ornith",
          clientId: "su-carry-off",
          backendWindow: 204800,
        },
        home,
      );
      err.mockRestore();
      const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
      expect(written).toContain("carryOwner=su-carry-off");
      expect(written).toMatch(/\n\s+strategy:\s*context-full/);
    } finally {
      if (saved === undefined)
        delete process.env.PAPERCUSP_OMP_CARRY_COMPACTION;
      else process.env.PAPERCUSP_OMP_CARRY_COMPACTION = saved;
    }
  });

  it("falls back to the config.yml modelRoles.default when no model opt is passed", () => {
    // AGENT_CFG's default is a gateway-routed hosted model; with no clientId the
    // forced block is the mechanical shake (P-022 — no endpoint without an owner)…
    writeOmpSessionConfigDir("sess1", {}, home);
    const gwWritten = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(gwWritten).not.toContain("/maintenance/summarize");
    expect(gwWritten).toMatch(/\n\s+strategy:\s*shake/);
    // …and a LOCAL default (the incident box's actual config) seeds shake even with model omitted.
    writeFileSync(
      join(home, ".omp", "agent", "config.yml"),
      AGENT_CFG.replace(
        "papercusp-gateway/claude-sonnet-4-6",
        "ollama-cc/maxwell1500/ornith-35b:IQ3_M:xhigh",
      ),
    );
    writeOmpSessionConfigDir("sess2", {}, home);
    const written = readFileSync(agentPath("sess2", "config.yml"), "utf8");
    expect(written).toMatch(/\n\s+strategy:\s*shake/);
  });

  it("REPLACES an inherited compaction block for EVERY omp session (remove-then-append, no duplicate key) — hosted models included (P-022)", () => {
    const withCompaction =
      AGENT_CFG +
      "compaction:\n  strategy: snapcompact\n  thresholdPercent: 90\n";
    writeFileSync(join(home, ".omp", "agent", "config.yml"), withCompaction);
    writeOmpSessionConfigDir("sess1", { model: "ollama/ornith" }, home);
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect((written.match(/^compaction:/gm) ?? []).length).toBe(1);
    expect(written).not.toContain("snapcompact");
    expect(written).toMatch(/\n\s+thresholdPercent:\s*70/);
    // P-022: a direct-API hosted model no longer keeps the inherited native
    // strategy — snapcompact is stripped and the mechanical shake rules.
    writeOmpSessionConfigDir(
      "sess2",
      { model: "anthropic/claude-opus-4-8" },
      home,
    );
    const hosted = readFileSync(agentPath("sess2", "config.yml"), "utf8");
    expect(hosted).not.toContain("snapcompact");
    expect((hosted.match(/^compaction:/gm) ?? []).length).toBe(1);
    expect(hosted).toMatch(/\n\s+strategy:\s*shake/);
  });

  it("strips flat dotted compaction.* keys too (both spellings are valid omp settings)", () => {
    const withFlat =
      AGENT_CFG +
      "compaction.strategy: snapcompact\ncompaction.thresholdPercent: 95\n";
    writeFileSync(join(home, ".omp", "agent", "config.yml"), withFlat);
    writeOmpSessionConfigDir("sess1", { model: "ollama/ornith" }, home);
    const written = readFileSync(agentPath("sess1", "config.yml"), "utf8");
    expect(written).not.toContain("snapcompact");
    expect(written).not.toContain("compaction.thresholdPercent");
    expect(written).toMatch(/\n\s+strategy:\s*shake/);
  });

  it("carries the faithful model registry + auth so model resolution survives relocation", () => {
    writeOmpSessionConfigDir("sess1", {}, home);
    expect(readFileSync(agentPath("sess1", "auth.json"), "utf8")).toBe(
      '{"token":"AUTHSECRET"}',
    );
    expect(existsSync(agentPath("sess1", "models.yml"))).toBe(true);
    expect(readFileSync(agentPath("sess1", "models.db"), "utf8")).toBe(
      "BINARYREGISTRY",
    );
  });

  it.each(["models.yml", "models.json"])("attributes copied %s gateway requests to the session without changing routes", (file) => {
    const registry = {
      providers: {
        "papercusp-gateway": {
          baseUrl: "http://127.0.0.1:8788",
          apiKey: "papercusp-gateway",
          headers: { "X-Papercusp-Owner": "su-old", "x-papercusp-account": "chosen-account", "x-papercusp-priority": "interactive" },
          models: [{ id: "claude-sonnet-4-6", contextWindow: 123456, headers: { "x-papercusp-owner": "su-old-model", "x-custom": "keep" } }],
        },
        anthropic: { baseUrl: "https://api.anthropic.com", headers: { "x-custom": "direct" }, models: [{ id: "claude-opus-4-8" }] },
      },
    };
    const source = file.endsWith(".json") ? JSON.stringify(registry) : "# Keep this registry comment\n" + stringifyYaml(registry);
    writeFileSync(join(home, ".omp", "agent", file), source);
    expect(writeOmpSessionConfigDir("attributed", { clientId: "su-current" }, home)).toBe(relDir("attributed"));
    const copy = readFileSync(agentPath("attributed", file), "utf8");
    const actual = file.endsWith(".json") ? JSON.parse(copy) : parseYaml(copy);
    const expected = structuredClone(registry);
    const headers = expected.providers["papercusp-gateway"].headers as Record<string, string>;
    delete headers["X-Papercusp-Owner"];
    headers["x-papercusp-owner"] = "su-current";
    expected.providers["papercusp-gateway"].models[0].headers["x-papercusp-owner"] = "su-current";
    expect(actual).toEqual(expected);
    if (file.endsWith(".yml")) expect(copy).toContain("# Keep this registry comment");
    expect(readFileSync(join(home, ".omp", "agent", file), "utf8")).toBe(source);
  });

  it("attributes legacy JSON gateway model entries and leaves direct models intact", () => {
    const registry = { models: [
      { provider: "papercusp-gateway", id: "claude-sonnet-4-6", headers: { "x-papercusp-account": "chosen-account" } },
      { provider: "anthropic", id: "claude-opus-4-8" },
    ] };
    writeFileSync(join(home, ".omp", "agent", "models.json"), JSON.stringify(registry));
    writeOmpSessionConfigDir("legacy", { clientId: "su-current" }, home);
    const actual = JSON.parse(readFileSync(agentPath("legacy", "models.json"), "utf8"));
    expect(actual.models[0]).toEqual({ ...registry.models[0], headers: {
      "x-papercusp-account": "chosen-account", "x-papercusp-owner": "su-current",
    } });
    expect(actual.models[1]).toEqual(registry.models[1]);
  });

  it("attributes authoritative bootstrap YAML without replacing its chosen model or account", () => {
    const registry = { providers: { "papercusp-gateway": {
      baseUrl: "http://127.0.0.1:8788/v1", api: "openai-responses",
      headers: { "x-papercusp-account": "codex-pin" }, models: [{ id: "gpt-5.6-terra" }],
    } } };
    writeOmpSessionConfigDir("bootstrap", { clientId: "su-current", modelsYml: stringifyYaml(registry) }, home);
    expect(parseYaml(readFileSync(agentPath("bootstrap", "models.yml"), "utf8")))
      .toEqual({ providers: { "papercusp-gateway": { ...registry.providers["papercusp-gateway"],
        headers: { "x-papercusp-account": "codex-pin", "x-papercusp-owner": "su-current" },
      } } });
  });

  it.each(["models.yml", "models.json"])("prepares OAuth request formatting in copied %s gateway registries", (file) => {
    const registry = { providers: {
      "papercusp-gateway": { api: "anthropic-messages", auth: "apiKey", apiKey: "papercusp-gateway",
        models: [{ id: "claude-sonnet-4-6", maxTokens: 8192 }] },
      anthropic: { api: "anthropic-messages", auth: "apiKey", apiKey: "DIRECT_KEY" },
    } };
    const source = file.endsWith(".json") ? JSON.stringify(registry) : stringifyYaml(registry);
    writeFileSync(join(home, ".omp", "agent", file), source);
    writeOmpSessionConfigDir("oauth", {}, home);
    const copy = readFileSync(agentPath("oauth", file), "utf8");
    const actual = file.endsWith(".json") ? JSON.parse(copy) : parseYaml(copy);
    expect(actual).toEqual({ providers: { ...registry.providers,
      "papercusp-gateway": { ...registry.providers["papercusp-gateway"], auth: "oauth" },
    } });
    expect(readFileSync(join(home, ".omp", "agent", file), "utf8")).toBe(source);
  });

  // xai-oauth (and other modern OMP logins) live in agent.db auth_credentials —
  // not legacy auth.json. Without this symlink, psu→omp sessions boot with an
  // empty credential store and Grok vanishes from /model even though bare omp works.
  it("symlinks agent.db so OAuth providers (xai-oauth etc.) survive PI_CONFIG_DIR relocation", () => {
    writeFileSync(join(home, ".omp", "agent", "agent.db"), "OAUTH_DB_BYTES");
    writeOmpSessionConfigDir("sess1", {}, home);
    const dst = agentPath("sess1", "agent.db");
    expect(lstatSync(dst).isSymbolicLink()).toBe(true);
    expect(realpathSync(dst)).toBe(
      realpathSync(join(home, ".omp", "agent", "agent.db")),
    );
    expect(readFileSync(dst, "utf8")).toBe("OAUTH_DB_BYTES");
  });

  it("does not fail when global agent.db is missing (degrades to OMP native auth error)", () => {
    // beforeEach seeds no agent.db — seed must still succeed for models/mcp.
    const dir = writeOmpSessionConfigDir("sess1", {}, home);
    expect(dir).toBe(relDir("sess1"));
    expect(existsSync(agentPath("sess1", "agent.db"))).toBe(false);
    expect(existsSync(agentPath("sess1", "mcp.json"))).toBe(true);
  });

  it("replaces a stale non-symlink agent.db (pre-fix empty session db) with a symlink", () => {
    writeFileSync(join(home, ".omp", "agent", "agent.db"), "GLOBAL_OAUTH");
    const pre = join(home, relDir("sess1"), "agent");
    mkdirSync(pre, { recursive: true });
    writeFileSync(join(pre, "agent.db"), ""); // empty real file as a broken prior psu session
    writeFileSync(join(pre, "agent.db-wal"), "STALE_WAL");
    writeOmpSessionConfigDir("sess1", {}, home);
    const dst = agentPath("sess1", "agent.db");
    expect(lstatSync(dst).isSymbolicLink()).toBe(true);
    expect(readFileSync(dst, "utf8")).toBe("GLOBAL_OAUTH");
    expect(existsSync(agentPath("sess1", "agent.db-wal"))).toBe(false);
  });

  it("linkOmpAgentDb is a no-op when already correctly linked", () => {
    writeFileSync(join(home, ".omp", "agent", "agent.db"), "OAUTH");
    const dstAgent = join(home, "dst-agent");
    mkdirSync(dstAgent, { recursive: true });
    linkOmpAgentDb(join(home, ".omp", "agent"), dstAgent);
    const before = lstatSync(join(dstAgent, "agent.db"));
    linkOmpAgentDb(join(home, ".omp", "agent"), dstAgent);
    const after = lstatSync(join(dstAgent, "agent.db"));
    expect(after.isSymbolicLink()).toBe(true);
    expect(after.ino).toBe(before.ino);
  });

  it("carries mcp.json so the relocated session keeps papercusp-su (the old full-mode bug)", () => {
    writeOmpSessionConfigDir("sess1", {}, home);
    const mcp = JSON.parse(
      readFileSync(agentPath("sess1", "mcp.json"), "utf8"),
    );
    expect(mcp.mcpServers["papercusp-su"].url).toContain(
      "/api/mcp?superuser=1",
    );
    expect(mcp.mcpServers["papercusp-su"].url).not.toContain("tools="); // no trim without the opt
  });

  it("trimmed mode keeps only papercusp-su plus optional context7 MCP servers (P-032 recurrence guard)", () => {
    const globalMcp = {
      mcpServers: {
        "papercusp-su": JSON.parse(MCP_JSON).mcpServers["papercusp-su"],
        context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
        "playwright-chromium": { command: "npx", args: ["playwright-mcp"] },
        github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        "cloudflare-docs": {
          type: "http",
          url: "https://docs.mcp.cloudflare.com/mcp",
        },
      },
    };
    writeFileSync(
      join(home, ".omp", "agent", "mcp.json"),
      JSON.stringify(globalMcp),
    );

    writeOmpSessionConfigDir(
      "sess1",
      { toolsAllowlist: OMP_CORE_MCP_TOOL_NAMES },
      home,
    );

    const written = JSON.parse(
      readFileSync(agentPath("sess1", "mcp.json"), "utf8"),
    );
    expect(Object.keys(written.mcpServers)).toEqual([
      "papercusp-su",
      "context7",
    ]);
    expect(
      new URL(written.mcpServers["papercusp-su"].url).searchParams
        .get("tools")!
        .split(","),
    ).toEqual([...OMP_CORE_MCP_TOOL_NAMES]);
    expect(
      JSON.parse(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf8")),
    ).toEqual(globalMcp);
  });

  // The shape under test is a ROLE launch (discoveryOff, no toolsAllowlist) — role
  // launches are what skip the server-map filter now that 'full' is retired.
  it("a role launch (no toolsAllowlist) preserves the complete user-selected MCP server map", () => {
    const globalMcp = {
      mcpServers: {
        "papercusp-su": JSON.parse(MCP_JSON).mcpServers["papercusp-su"],
        "playwright-chromium": { command: "npx", args: ["playwright-mcp"] },
        github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
      },
    };
    writeFileSync(
      join(home, ".omp", "agent", "mcp.json"),
      JSON.stringify(globalMcp),
    );

    writeOmpSessionConfigDir("sess1", { discoveryOff: true }, home);

    const written = JSON.parse(
      readFileSync(agentPath("sess1", "mcp.json"), "utf8"),
    );
    expect(Object.keys(written.mcpServers)).toEqual(
      Object.keys(globalMcp.mcpServers),
    );
  });

  it("weak trim (toolsAllowlist) rewrites the papercusp-su URL with ?tools=<core>", () => {
    const dir = writeOmpSessionConfigDir(
      "sess1",
      { toolsAllowlist: OMP_CORE_MCP_TOOL_NAMES },
      home,
    );
    const mcp = JSON.parse(
      readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"),
    );
    const url = new URL(mcp.mcpServers["papercusp-su"].url);
    // The server decodes the param and splits on comma → the exact core list.
    expect(url.searchParams.get("tools")!.split(",")).toEqual([
      ...OMP_CORE_MCP_TOOL_NAMES,
    ]);
    // Existing params + auth header survive untouched.
    expect(url.searchParams.get("superuser")).toBe("1");
    expect(mcp.mcpServers["papercusp-su"].headers.Authorization).toBe(
      "Bearer SECRET",
    );
  });

  it("WI-1866: clientId stamps the per-session coord ownerId as ?client=, overriding the baked per-machine id", () => {
    // The user-level template bakes ONE per-machine client id, and omp cannot env-expand the
    // SID at connect (unlike claude's ${PAPERCUSP_SID} url) — so without this override every
    // omp session on the box collapsed into a single shared in-band coord identity (shared
    // claims, void member-vs-member claim conflicts, wakes to the visible id black-holing).
    const dir = writeOmpSessionConfigDir(
      "sess1",
      { clientId: "su-638fab72-65c7-4dec-b45b-3acb5552d350" },
      home,
    );
    const mcp = JSON.parse(
      readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"),
    );
    const url = new URL(mcp.mcpServers["papercusp-su"].url);
    expect(url.searchParams.get("client")).toBe(
      "su-638fab72-65c7-4dec-b45b-3acb5552d350",
    );
    expect(url.searchParams.get("superuser")).toBe("1"); // rest of the query survives
  });

  it("WI-1866: without clientId the baked client param is left untouched (no regression)", () => {
    const dir = writeOmpSessionConfigDir("sess1", {}, home);
    const mcp = JSON.parse(
      readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"),
    );
    const url = new URL(mcp.mcpServers["papercusp-su"].url);
    expect(url.searchParams.get("client")).toBe("abc");
  });

  it("rewrites the papercusp server ORIGIN to the launcher-resolved operator URL (P-030)", () => {
    // The user-level mcp.json pins :3070; a session launched with
    // PAPERCUSP_OPERATOR_URL (or riding the resilient proxy) must have its COPY
    // follow the launcher's operator, or the member talks to a different host.
    const dir = writeOmpSessionConfigDir(
      "sess1",
      { operatorUrl: "http://localhost:3170" },
      home,
    );
    const mcp = JSON.parse(
      readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"),
    );
    const url = new URL(mcp.mcpServers["papercusp-su"].url);
    expect(url.origin).toBe("http://localhost:3170");
    expect(url.pathname).toBe("/api/mcp");
    expect(url.searchParams.get("superuser")).toBe("1"); // query survives the origin swap
    expect(mcp.mcpServers["papercusp-su"].headers.Authorization).toBe(
      "Bearer SECRET",
    );
  });

  it("recovers a stale runtime port before writing the per-session MCP origin", async () => {
    const probed: string[] = [];
    const recoveries: Array<Record<string, string | null>> = [];
    const dir = await writeOmpSessionConfigDirAsync(
      "stale-port",
      {
        env: { PAPERCUSP_HONO_PORT: "3271" },
        probe: async (candidate: string) => {
          probed.push(candidate);
          return candidate === "http://127.0.0.1:3070/api/mcp";
        },
        onRecovery: (recovery: Record<string, string | null>) => {
          recoveries.push(recovery);
        },
      },
      home,
    );
    const url = new URL(
      JSON.parse(readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"))
        .mcpServers["papercusp-su"].url,
    );
    expect(url.origin).toBe("http://127.0.0.1:3070");
    expect(probed).toEqual([
      "http://127.0.0.1:3271/api/mcp",
      "http://127.0.0.1:3070/api/mcp",
    ]);
    expect(recoveries).toEqual([
      {
        configuredBase: "http://127.0.0.1:3271",
        recoveredBase: "http://127.0.0.1:3070",
        configuredPort: "3271",
      },
    ]);
  });

  it("keeps a live non-green runtime port when writing the per-session MCP origin", async () => {
    const probed: string[] = [];
    const dir = await writeOmpSessionConfigDirAsync(
      "staging-port",
      {
        env: { PAPERCUSP_HONO_PORT: "3170" },
        probe: async (candidate: string) => {
          probed.push(candidate);
          return candidate === "http://127.0.0.1:3170/api/mcp";
        },
      },
      home,
    );
    const url = new URL(
      JSON.parse(readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"))
        .mcpServers["papercusp-su"].url,
    );
    expect(url.origin).toBe("http://127.0.0.1:3170");
    expect(probed).toEqual(["http://127.0.0.1:3170/api/mcp"]);
  });

  it("honors an explicit operator URL without probing or recovering it", async () => {
    const probe = vi.fn(async () => {
      throw new Error("explicit pins must not probe");
    });
    const dir = await writeOmpSessionConfigDirAsync(
      "explicit-port",
      {
        operatorUrl: "http://localhost:3999",
        env: { PAPERCUSP_HONO_PORT: "3271" },
        probe,
      },
      home,
    );
    const url = new URL(
      JSON.parse(readFileSync(join(home, dir!, "agent", "mcp.json"), "utf8"))
        .mcpServers["papercusp-su"].url,
    );
    expect(url.origin).toBe("http://localhost:3999");
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns null for a falsy sessionId (no dir written)", () => {
    expect(writeOmpSessionConfigDir("", {}, home)).toBeNull();
    expect(writeOmpSessionConfigDir(null, {}, home)).toBeNull();
    expect(writeOmpSessionConfigDir(undefined, {}, home)).toBeNull();
  });

  it("returns null when the global OMP config is missing (falls back to native default)", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "psu-noomp-"));
    try {
      expect(writeOmpSessionConfigDir("sess3", {}, emptyHome)).toBeNull();
      expect(existsSync(join(emptyHome, ".papercusp", "su-omp-homes"))).toBe(
        false,
      );
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

const processEnv = (values: Record<string, string>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe("ompCoreToolNames (PAPERCUSP_OMP_TOOLS_EXCLUDE — spine trim escape hatch)", () => {
  // D-005: this is now the DERIVED set, not the OMP_CORE_MCP_TOOL_NAMES literal. Asserting
  // against the generated artifact (rather than re-listing 90 names here) is deliberate — a
  // second hand list in the test file would reintroduce, in the guard itself, exactly the
  // hand-maintained copy this plan removed from the source.
  const ompAdvertised = [...OMP_TOOL_DELIVERY_ARTIFACT.advertised];

  it("returns the full derived seed when the env var is unset/empty", () => {
    expect(ompCoreToolNames(processEnv({}))).toEqual(ompAdvertised);
    expect(
      ompCoreToolNames(processEnv({ PAPERCUSP_OMP_TOOLS_EXCLUDE: "" })),
    ).toEqual(ompAdvertised);
  });

  it("drops the named tools (comma-separated, whitespace-tolerant), keeping the rest in order", () => {
    // Exclude two tools that ARE in the derived seed so the length-2 assertion stays
    // meaningful; both are floors, so they cannot silently leave the seed and make this
    // guard vacuous.
    const kept = ompCoreToolNames(
      processEnv({
        PAPERCUSP_OMP_TOOLS_EXCLUDE: "coord:declare-intent, coord:inbox",
      }),
    );
    expect(ompAdvertised).toContain("coord:declare-intent"); // non-vacuity
    expect(ompAdvertised).toContain("coord:inbox");
    expect(kept).not.toContain("coord:declare-intent");
    expect(kept).not.toContain("coord:inbox");
    expect(kept.length).toBe(ompAdvertised.length - 2);
    expect(kept[0]).toBe(
      ompAdvertised.find((n) => n !== "coord:declare-intent" && n !== "coord:inbox"),
    ); // order preserved
  });

  it("ignores names not in the spine (no-op, no error)", () => {
    expect(
      ompCoreToolNames(
        processEnv({ PAPERCUSP_OMP_TOOLS_EXCLUDE: "not:a-tool" }),
      ),
    ).toEqual(ompAdvertised);
  });

  it("ompCompactToolNames is a strict SUBSET of what ompCoreToolNames advertises", () => {
    // A compact name that is not advertised has no tier to apply — the server reaches it
    // only after the allowlist filter, so naming one is a silent no-op that reads like a
    // saving. Excluding a tool must therefore drop it from BOTH lists.
    const compact = ompCompactToolNames(processEnv({}));
    expect(compact.length).toBeGreaterThan(0);
    for (const n of compact) expect(ompAdvertised).toContain(n);
    const victim = compact[0];
    expect(
      ompCompactToolNames(processEnv({ PAPERCUSP_OMP_TOOLS_EXCLUDE: victim })),
    ).not.toContain(victim);
  });
});

describe("claudeSeedToolNames (EI-23319364088969722 — Claude's own minimal seed)", () => {
  it("defaults to the DERIVED delivery map, not either hand list", () => {
    // The original defect: Claude DERIVED its seed from the weak-model spine
    // (ompCoreToolNames() + the extras = 64 names, 432,714 B measured on the wire), so
    // the model BEST able to drive tools:invoke received the LARGEST up-front surface.
    // The 2026-09-15 answer was a second hand list (31 names). Both were hand lists, and a
    // hand list regrows one defensible append at a time — which is how the first one
    // reached 432,714 B. The seed is now a FUNCTION of measured demand and measured bytes.
    const seed = claudeSeedToolNames(processEnv({}));
    expect(seed).toEqual([...CLAUDE_TOOL_DELIVERY_ARTIFACT.advertised]);
    expect(new Set(seed).size).toBe(seed.length);
  });

  it("STRICTLY WIDENS the 31-name hand cut it replaces — no name lost", () => {
    // The load-bearing no-regression claim. The derived map is allowed to ADD tools (that
    // is the point of the COMPACT tier), but a name the 2026-09-15 cut deemed mandatory
    // must not fall out on a value-density ranking: that would be a capability regression
    // wearing a byte saving's clothes. Asserted per-name so a failure says WHICH one.
    const seed = new Set(claudeSeedToolNames(processEnv({})));
    for (const n of CLAUDE_MINIMAL_SEED_TOOL_NAMES)
      expect(seed.has(n), `${n} was in the 31-name cut and is no longer advertised`).toBe(
        true,
      );
    expect(seed.size).toBeGreaterThan(CLAUDE_MINIMAL_SEED_TOOL_NAMES.length);
  });

  it("claudeCompactToolNames follows the generated tier map for either advertised seed", () => {
    const advertised = new Set(claudeSeedToolNames(processEnv({})));
    const compact = claudeCompactToolNames(processEnv({}));
    expect(compact.length).toBeGreaterThan(0);
    for (const n of compact) expect(advertised.has(n)).toBe(true);
    const fullSeed = claudeSeedToolNames(processEnv({ PAPERCUSP_CLAUDE_FULL_SEED: "1" }));
    const fullCompact = claudeCompactToolNames(processEnv({ PAPERCUSP_CLAUDE_FULL_SEED: "1" }));
    const expectedFullCompact = fullSeed.filter(
      (name) => CLAUDE_TOOL_DELIVERY_ARTIFACT.tiers[name] === "compact",
    );
    expect([...fullCompact].sort()).toEqual([...expectedFullCompact].sort());
  });

  it("always seeds the reachability pair — the trim's load-bearing assumption", () => {
    // Everything NOT seeded stays usable ONLY because tools:find searches the full
    // catalog (and activates matches) and tools:invoke dispatches any tool by name.
    // Drop either and the trim stops being a latency budget and becomes a capability
    // boundary — which is exactly the EI-9011 failure this cut is designed to avoid.
    const seed = claudeSeedToolNames(processEnv({}));
    expect(seed).toContain("tools:find");
    expect(seed).toContain("tools:invoke");
  });

  it("carries the seven measured heavies AT COMPACT — the point of three-way admission (D-010)", () => {
    // ⚠ THIS ASSERTION IS THE EXACT INVERSE OF THE ONE IT REPLACES, deliberately. The old
    // guard said these seven must stay OUT, because in a two-way admission they cost
    // 187,841 B — 43% of the old 432,714 B seed for SEVEN names — and there was no way to
    // carry them for less. That was a true statement about a FULL-or-nothing world.
    //
    // They are all in the owner-directed Aug-20 baseline, which D-010 made a floor after
    // P-012's diff caught the ranking dropping 20 of its 61 names. At COMPACT the same
    // seven cost a fraction of that, which is precisely what D-002's third tier bought:
    // the choice stopped being "pay 32,612 B for coord:send or lose it" and became "pay
    // 6,164 B for it".
    //
    // So the saving is NOT located in their absence any more — it is located in their
    // TIER. That is what this now guards: present, and present at compact.
    const seed = claudeSeedToolNames(processEnv({}));
    const compact = new Set(claudeCompactToolNames(processEnv({})));
    for (const n of [
      "work_items:complete",
      "coord:send",
      "work_items:checkpoint",
      "fleet:launch-on-plan",
      "loop:checkpoint",
      "improvements:capture",
      "facts:assert",
    ]) {
      expect(seed, `${n} is in the owner-directed Aug-20 baseline (D-010) and must be advertised`).toContain(n);
      expect(
        compact.has(n),
        `${n} is one of the seven measured heavies — advertising it at FULL is what the ` +
          `two-way admission could not afford, so it must ship COMPACT`,
      ).toBe(true);
    }
  });

  it("PAPERCUSP_CLAUDE_FULL_SEED restores the historical spine+extras seed exactly", () => {
    // The instant revert if the minimal seed ever proves too thin.
    const seed = claudeSeedToolNames(
      processEnv({ PAPERCUSP_CLAUDE_FULL_SEED: "1" }),
    );
    for (const n of OMP_CORE_MCP_TOOL_NAMES) expect(seed).toContain(n);
    for (const n of CLAUDE_SEED_EXTRA_TOOL_NAMES) expect(seed).toContain(n);
    expect(new Set(seed).size).toBe(seed.length);
    expect(seed.length).toBe(
      OMP_CORE_MCP_TOOL_NAMES.length + CLAUDE_SEED_EXTRA_TOOL_NAMES.length,
    );
  });

  it("treats unset / '0' / 'false' as derived (a hatch that opens on \"0\" is worse than none)", () => {
    // Compare the NAMES, not the count: an equal-length curated list would satisfy a
    // length check while advertising a different set of tools, which is precisely the
    // hand-maintained second copy this plan removed. Length is a proxy; identity is the
    // claim.
    const derived = [...CLAUDE_TOOL_DELIVERY_ARTIFACT.advertised];
    for (const v of ["", "0", "false", "False"]) {
      expect(
        claudeSeedToolNames(processEnv({ PAPERCUSP_CLAUDE_FULL_SEED: v })),
      ).toEqual(derived);
    }
  });

  it("BUDGET: the derived seed is bounded by BYTES, not by a name count (D-009)", () => {
    // CLAUDE_MINIMAL_SEED_MAX_NAMES (31) is RETIRED, and its retirement is the point.
    // A name ratchet is a proxy for the thing that actually costs — a 31-name list at
    // 106,873 B was over budget while a 90-name derived map fits in 99,898 B — so the
    // ratchet was simultaneously too tight (it forbade cheap names) and too loose (it
    // permitted expensive ones). The budget is now the measured wire total, enforced by
    // the generator, and this asserts the artifact never ships over it.
    expect(CLAUDE_TOOL_DELIVERY_ARTIFACT.spentBytes).toBeLessThanOrEqual(
      CLAUDE_TOOL_DELIVERY_ARTIFACT.budgetBytes,
    );
    expect(CLAUDE_TOOL_DELIVERY_ARTIFACT.budgetOverrun).toBe(0);
    // Non-vacuity: a budget guard over an empty/degraded map would pass while measuring
    // nothing — which is exactly what a truncated catalog produces.
    expect(CLAUDE_TOOL_DELIVERY_ARTIFACT.advertised.length).toBeGreaterThan(40);
    expect(CLAUDE_TOOL_DELIVERY_ARTIFACT.spentBytes).toBeGreaterThan(50_000);
    // Every entry must be a real catalog name — a typo would otherwise be advertised as a
    // tool that does not exist, and `?tools=` would silently drop it. (Not all names are
    // colon form: the catalog carries dot-form plugin verbs such as `gitnexus.context`.)
    for (const n of CLAUDE_TOOL_DELIVERY_ARTIFACT.advertised)
      expect(n, `${n} is not a server:verb / server.verb catalog name`).toMatch(
        /^[a-z][a-z0-9_-]*[.:][a-z][a-z0-9_-]*$/i,
      );
  });

  it("CONTROL: the byte budget actually fires when the map regrows", () => {
    // A budget guard nobody has seen fail is a budget guard nobody has tested. Proves the
    // assertion above can go red, without mutating the shared tree (the repo's own
    // falsifiability guidance: a probe that edits a tracked file can be committed by the
    // git-sync sweep mid-run).
    const overrun =
      CLAUDE_TOOL_DELIVERY_ARTIFACT.spentBytes +
      (CLAUDE_TOOL_DELIVERY_ARTIFACT.budgetBytes -
        CLAUDE_TOOL_DELIVERY_ARTIFACT.spentBytes) +
      1;
    expect(overrun).toBeGreaterThan(CLAUDE_TOOL_DELIVERY_ARTIFACT.budgetBytes);
  });

  it("BUDGET: a non-zero overrun fails the build for EVERY agent kind, not just claude", () => {
    // The guard above covers claude alone, which made "no agent kind ships over budget" a
    // claim about one third of the artifact. D-009 unified all three kinds onto ONE
    // budget, so all three owe the same assertion — otherwise a codex/omp regrowth ships
    // over budget with every test still green.
    //
    // WHAT THIS ACTUALLY ASSERTS, stated precisely because the loose version is vacuous:
    // floors are never DEFERRED (resolveToolDelivery admits every floor even when the
    // floors alone exceed the budget — see tool-delivery-policy.test.ts:162-176, which
    // expects deferred=0 with overrun=500). The overrun is then REPORTED rather than
    // silently absorbed, and a non-zero report fails HERE. So "a floor was dropped to fit"
    // is unreachable by construction; "we shipped over budget" is what this catches.
    for (const [kind, artifact] of [
      ["claude", CLAUDE_TOOL_DELIVERY_ARTIFACT],
      ["codex", CODEX_TOOL_DELIVERY_ARTIFACT],
      ["omp", OMP_TOOL_DELIVERY_ARTIFACT],
    ] as const) {
      expect(artifact.budgetOverrun, `${kind} ships with a non-zero budget overrun`).toBe(0);
      expect(
        artifact.spentBytes,
        `${kind} spends more than its budget`,
      ).toBeLessThanOrEqual(artifact.budgetBytes);
      // Non-vacuity, per kind: an empty or degraded map would satisfy both assertions
      // above while measuring nothing at all.
      expect(artifact.advertised.length, `${kind} advertises a degenerate map`).toBeGreaterThan(40);
      expect(artifact.spentBytes, `${kind} spends a degenerate number of bytes`).toBeGreaterThan(50_000);
    }
  });

  it("ONE POLICY produces every agent kind's seed (D-005) — they are no longer disjoint lists", () => {
    // RETIRES the old "every Claude-only extra stays OUT of the weak-model OMP spine"
    // rule. That rule existed for one reason: the two seeds were separate HAND LISTS, so
    // something had to stop a name being argued into both. They are now one call to
    // `resolveToolDelivery()` against one catalog and one budget, so disjointness is not
    // merely unenforced — it is FALSE, and asserting it would forbid the unification the
    // owner directed (D-005).
    expect(claudeSeedToolNames(processEnv({}))).toEqual(
      ompCoreToolNames(processEnv({})),
    );
    expect(claudeCompactToolNames(processEnv({}))).toEqual(
      ompCompactToolNames(processEnv({})),
    );
    // The substantive half of the retired rule survives as a POSITIVE claim: the
    // Claude-only mandates the extras list existed to carry are advertised to EVERY kind,
    // rather than kept out of one. Non-vacuous — these three are the WI-37534 additions.
    for (const n of ["state:read", "capability:bash", "capability:bash_output"]) {
      expect(CLAUDE_SEED_EXTRA_TOOL_NAMES).toContain(n);
      expect(ompCoreToolNames(processEnv({}))).toContain(n);
    }
  });

  it("seeds the CLAUDE-only prompt-mandated verbs (WI-37534)", () => {
    // Regression guard. Each of these is REQUIRED by documentation the agent must follow
    // (root CLAUDE.md's volatile-value re-read rule and its long-jobs rule), while Claude's
    // native ToolSearch indexes ONLY the advertised subset — so an unseeded name answers
    // "No matching deferred tools found", which reads as "this tool does not exist".
    // Measured before the fix: 68/111/119 tools:invoke fallback reaches per 14d.
    const seed = claudeSeedToolNames(processEnv({}));
    for (const n of [
      "state:read",
      "capability:bash",
      "capability:bash_output",
    ]) {
      expect(seed).toContain(n);
    }
  });

  it("never seeds capability:bash without its reader (a bash_id nobody can read)", () => {
    // These two are inseparable: the long-jobs rule says launch with
    // capability:bash { run_in_background: true } and read with capability:bash_output.
    // Seeding only the launcher strands every background job, which is exactly why
    // bash_output out-reached bash (119 vs 111) before the fix.
    const seed = claudeSeedToolNames(processEnv({}));
    expect(seed.includes("capability:bash")).toBe(
      seed.includes("capability:bash_output"),
    );
  });

  it("honors the spine exclude escape hatch without touching the lock extras", () => {
    const seed = claudeSeedToolNames(
      processEnv({ PAPERCUSP_OMP_TOOLS_EXCLUDE: "coord:glance" }),
    );
    expect(seed).not.toContain("coord:glance");
    expect(seed).toContain("locks:acquire");
  });
});

describe("applyOmpMcpUrlParams (stamp caller backend/model — fleet-launch-agent-inheritance-2026-07-03)", () => {
  const mk = (url: string) =>
    JSON.stringify({ mcpServers: { "papercusp-su": { url } } });
  const urlOf = (json: string) =>
    new URL(JSON.parse(json).mcpServers["papercusp-su"].url);

  it("stamps agent + model onto a papercusp /api/mcp url", () => {
    const out = applyOmpMcpUrlParams(
      mk("http://127.0.0.1:3070/api/mcp?superuser=1&client=x"),
      {
        agent: "omp",
        model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
      },
    );
    const u = urlOf(out);
    expect(u.searchParams.get("agent")).toBe("omp");
    expect(u.searchParams.get("model")).toBe(
      "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
    );
    // pre-existing params survive
    expect(u.searchParams.get("superuser")).toBe("1");
    expect(u.searchParams.get("client")).toBe("x");
  });

  it("omits empty/undefined params (no bare &model=)", () => {
    const u = urlOf(
      applyOmpMcpUrlParams(mk("http://127.0.0.1:3070/api/mcp?superuser=1"), {
        agent: "omp",
        model: undefined,
      }),
    );
    expect(u.searchParams.get("agent")).toBe("omp");
    expect(u.searchParams.has("model")).toBe(false);
  });

  it("leaves non-papercusp server urls untouched", () => {
    const src = mk("http://example.com/other");
    expect(
      JSON.parse(applyOmpMcpUrlParams(src, { agent: "omp" })).mcpServers[
        "papercusp-su"
      ].url,
    ).toBe("http://example.com/other");
  });

  it("returns the input unchanged on invalid JSON", () => {
    expect(applyOmpMcpUrlParams("not json", { agent: "omp" })).toBe("not json");
  });
});

describe("applyOmpOperatorOrigin (P-030 — member mcp.json follows the launcher operator)", () => {
  it("swaps the origin of a papercusp /api/mcp url, preserving path + query verbatim", () => {
    const src = JSON.stringify({
      mcpServers: {
        "papercusp-su": {
          url: "http://localhost:3070/api/mcp?superuser=1&client=x&tools=a%3Ab",
          headers: { Authorization: "Bearer S" },
        },
      },
    });
    const out = JSON.parse(
      applyOmpOperatorOrigin(src, "http://127.0.0.1:9071"),
    );
    expect(out.mcpServers["papercusp-su"].url).toBe(
      "http://127.0.0.1:9071/api/mcp?superuser=1&client=x&tools=a%3Ab",
    );
    expect(out.mcpServers["papercusp-su"].headers.Authorization).toBe(
      "Bearer S",
    );
  });

  it("leaves non-papercusp server URLs untouched", () => {
    const src = JSON.stringify({
      mcpServers: { other: { url: "http://example.com/mcp" } },
    });
    const out = JSON.parse(
      applyOmpOperatorOrigin(src, "http://localhost:3170"),
    );
    expect(out.mcpServers.other.url).toBe("http://example.com/mcp");
  });

  it("returns the input unchanged on unparseable json or a bad operator url", () => {
    expect(applyOmpOperatorOrigin("not json", "http://localhost:3170")).toBe(
      "not json",
    );
    const src = JSON.stringify({
      mcpServers: { p: { url: "http://localhost:3070/api/mcp" } },
    });
    expect(applyOmpOperatorOrigin(src, "not-a-url")).toBe(src);
  });
});

describe("applyOmpOperatorBearer (WI-10003604 — the credential follows the re-pointed origin)", () => {
  const server = (url: string, headers?: Record<string, string>) =>
    JSON.stringify({ mcpServers: { p: { type: "http", url, ...(headers ? { headers } : {}) } } });
  const read = (text: string) => JSON.parse(text).mcpServers.p;

  it("replaces a stale bearer on a superuser papercusp server", () => {
    const out = read(applyOmpOperatorBearer(
      server("http://localhost:38931/api/mcp?superuser=1&client=x", { Authorization: "Bearer STALE", "x-a": "keep" }),
      "LIVE",
    ));
    expect(out.headers).toEqual({ "x-a": "keep", Authorization: "Bearer LIVE" });
  });

  it("drops every case variant so the server never receives two Authorization headers", () => {
    const out = read(applyOmpOperatorBearer(
      server("http://localhost:3070/api/mcp?superuser=1", { authorization: "Bearer STALE" }),
      "  LIVE\n",
    ));
    expect(out.headers).toEqual({ Authorization: "Bearer LIVE" });
  });

  it("adds headers when the template carried none", () => {
    const out = read(applyOmpOperatorBearer(server("http://localhost:3070/api/mcp?superuser=1"), "LIVE"));
    expect(out.headers).toEqual({ Authorization: "Bearer LIVE" });
  });

  it.each([
    ["a non-superuser papercusp server", "http://localhost:3070/api/mcp?client=x"],
    ["a non-papercusp server", "https://example.com/mcp?superuser=1"],
  ])("leaves %s untouched", (_label, url) => {
    const src = server(url, { Authorization: "Bearer OTHER" });
    expect(read(applyOmpOperatorBearer(src, "LIVE")).headers.Authorization).toBe("Bearer OTHER");
  });

  it.each([null, undefined, "", "   "])("returns the input unchanged for bearer %j", (bearer) => {
    const src = server("http://localhost:3070/api/mcp?superuser=1", { Authorization: "Bearer T" });
    expect(applyOmpOperatorBearer(src, bearer)).toBe(src);
  });

  it("returns the input unchanged on unparseable json", () => {
    expect(applyOmpOperatorBearer("not json", "LIVE")).toBe("not json");
  });
});

describe("applyOmpToolsAllowlist (weak-model-tool-tier — mcp.json URL trim)", () => {
  it("appends ?tools= to a papercusp /api/mcp url, encoded so the server decodes it back", () => {
    const src = JSON.stringify({
      mcpServers: {
        "papercusp-su": {
          url: "http://localhost:3070/api/mcp?superuser=1&client=x",
        },
      },
    });
    const out = JSON.parse(
      applyOmpToolsAllowlist(src, ["coord:orient", "tools:find"]),
    );
    const url = new URL(out.mcpServers["papercusp-su"].url);
    expect(url.searchParams.get("tools")!.split(",")).toEqual([
      "coord:orient",
      "tools:find",
    ]);
  });

  it("is idempotent — never double-appends tools= if one is already present", () => {
    const src = JSON.stringify({
      mcpServers: { p: { url: "http://localhost:3070/api/mcp?tools=a:b" } },
    });
    const out = JSON.parse(applyOmpToolsAllowlist(src, ["coord:orient"]));
    expect(out.mcpServers.p.url).toBe(
      "http://localhost:3070/api/mcp?tools=a:b",
    ); // untouched
  });

  it("leaves a non-papercusp server URL untouched", () => {
    const src = JSON.stringify({
      mcpServers: { other: { url: "http://example.com/mcp" } },
    });
    const out = JSON.parse(applyOmpToolsAllowlist(src, ["coord:orient"]));
    expect(out.mcpServers.other.url).toBe("http://example.com/mcp");
  });

  it("returns the input unchanged on unparseable JSON", () => {
    expect(applyOmpToolsAllowlist("not json{", ["coord:orient"])).toBe(
      "not json{",
    );
  });
});

describe("isWeakOmpModel / ompDefaultModel (weak-model-tool-tier — tier gate)", () => {
  it("classifies local-provider models as weak, hosted as not-weak, unknown as not-weak (safe)", () => {
    expect(isWeakOmpModel("ollama/maxwell1500/ornith-35b:IQ3_M:xhigh")).toBe(
      true,
    );
    expect(isWeakOmpModel("ollama-cc/maxwell1500/ornith-35b:IQ3_M")).toBe(true); // the incident model — was frontier before P-001
    expect(isWeakOmpModel("OLLAMA/ornith")).toBe(true); // case-insensitive
    expect(isWeakOmpModel("lmstudio/foo")).toBe(true);
    expect(isWeakOmpModel("anthropic/claude-opus-4-8")).toBe(false);
    expect(isWeakOmpModel("papercusp-gateway/claude-sonnet-4-6")).toBe(false);
    expect(isWeakOmpModel("")).toBe(false);
    expect(isWeakOmpModel(null)).toBe(false);
    expect(isWeakOmpModel(undefined)).toBe(false);
  });

  it("ompDefaultModel reads config.yml modelRoles.default (or null)", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-ompdef-"));
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".omp", "agent", "config.yml"),
        "modelRoles:\n  default: ollama/ornith:fast\n",
      );
      expect(ompDefaultModel(home)).toBe("ollama/ornith:fast");
      expect(isWeakOmpModel(ompDefaultModel(home))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(
      ompDefaultModel(mkdtempSync(join(tmpdir(), "psu-noomp2-"))),
    ).toBeNull();
  });
});

describe("OMP_CORE_MCP_TOOL_NAMES drift guard (weak-model-tool-tier)", () => {
  // psu-launcher.mjs is a plain node script with no TS imports, so it inlines the spine.
  // It is the inlined omp/weak-model copy of the canonical orchestrator CORE spine.
  // Any drift fails the build — edit the orchestrator source, then mirror here.
  // (The former second divergence — OMP dropping locks:acquire_granular/release_granular —
  // became a no-op in the 2026-07-05 demand-evidence rebalance, which cut the granular
  // lock tools from the CANONICAL list too: hooks auto-lock every Edit/Write on all
  // clients. The not-contains guard stays so they can't silently creep back into either.)
  const LOCK_TOOLS = ["locks:acquire_granular", "locks:release_granular"];

  it("carries no manual granular lock tools (auto-acquired on Edit/Write via hooks, both spines)", () => {
    for (const t of LOCK_TOOLS) {
      expect([...OMP_CORE_MCP_TOOL_NAMES]).not.toContain(t);
      expect([...CORE_MCP_TOOL_NAMES]).not.toContain(t);
    }
  });

  it("includes fleet:launch-on-plan so every trimmed routing-gate client can execute the fleet route", () => {
    expect([...OMP_CORE_MCP_TOOL_NAMES]).toContain("fleet:launch-on-plan");
    expect([...CORE_MCP_TOOL_NAMES]).toContain("fleet:launch-on-plan");
  });

  it("seeds coord:declare-intent immediately after coord:orient for post-bootstrap lane declaration", () => {
    expect([...OMP_CORE_MCP_TOOL_NAMES]).toContain("coord:declare-intent");
    expect([...CORE_MCP_TOOL_NAMES]).toContain("coord:declare-intent");
    expect(OMP_CORE_MCP_TOOL_NAMES.indexOf("coord:declare-intent")).toBe(
      OMP_CORE_MCP_TOOL_NAMES.indexOf("coord:orient") + 1,
    );
    expect(CORE_MCP_TOOL_NAMES.indexOf("coord:declare-intent")).toBe(
      CORE_MCP_TOOL_NAMES.indexOf("coord:orient") + 1,
    );
  });

  it("seeds work_items:release for worker handoffs instead of relying on deferred discovery", () => {
    // EI-8588: release existed server-side, but seeded worker/fleet surfaces omitted it,
    // so a member trying to return a misclaimed item could not discover/call the flat
    // MCP tool reliably from the trimmed surface.
    expect([...CORE_MCP_TOOL_NAMES]).toContain("work_items:release");
    expect([...OMP_CORE_MCP_TOOL_NAMES]).toContain("work_items:release");
  });

  it("seeds events:cancel as the correction half of events:await", () => {
    // EI-21345492095209440: a trimmed client that can register a wait must be able
    // to retract it without a tools:find/tools:invoke round-trip.
    expect([...CORE_MCP_TOOL_NAMES]).toContain("events:cancel");
    expect([...OMP_CORE_MCP_TOOL_NAMES]).toContain("events:cancel");
  });

  it("seeds checkpoint:await so trimmed Codex sessions have a direct release-gate wait wrapper from launch", () => {
    expect([...CORE_MCP_TOOL_NAMES]).toContain("checkpoint:await");
    expect([...OMP_CORE_MCP_TOOL_NAMES]).toContain("checkpoint:await");
  });

  it("is identical to the canonical orchestrator CORE_MCP_TOOL_NAMES, order preserved", () => {
    expect([...OMP_CORE_MCP_TOOL_NAMES]).toEqual([...CORE_MCP_TOOL_NAMES]);
  });
});

describe("applyGithubTokenEnv (GitHub MCP plugin token)", () => {
  const ghResult = (
    status: number,
    stdout: string,
  ): import("node:child_process").SpawnSyncReturns<string> => ({
    pid: 0,
    output: [stdout],
    stdout,
    stderr: "",
    status,
    signal: null,
  });

  it("exports the gh token into env when unset", () => {
    const env: Record<string, string> = {};
    applyGithubTokenEnv(env, { runGh: () => ghResult(0, "gho_abc123\n") });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("gho_abc123");
  });
  it("leaves an already-set token untouched", () => {
    const env: Record<string, string> = {
      GITHUB_PERSONAL_ACCESS_TOKEN: "preset",
    };
    applyGithubTokenEnv(env, { runGh: () => ghResult(0, "gho_other") });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("preset");
  });
  it("fail-soft when gh errors or is logged out (env unchanged)", () => {
    const env: Record<string, string> = {};
    applyGithubTokenEnv(env, { runGh: () => ghResult(1, "") });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    applyGithubTokenEnv(env, {
      runGh: () => {
        throw new Error("no gh");
      },
    });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
  });
});

describe("psu-launcher arg parsing", () => {
  it("recognizes --help and -h as terminal parser results without warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseArgs(["--help", "--model=not-a-real-model"])).toMatchObject({
        help: true,
      });
      expect(parseArgs(["-h"])).toMatchObject({ help: true });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("recognizes --version and -V as terminal parser results without warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseArgs(["--version", "--model=not-a-real-model"])).toMatchObject({
        version: true,
      });
      expect(parseArgs(["-V"])).toMatchObject({ version: true });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("runs --help without entering the picker or launch flow", () => {
    const launcher = join(__dirname, "..", "scripts", "psu-launcher.mjs");
    const result = spawnSync(
      process.execPath,
      [launcher, "--help", "--model=not-a-real-model"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(PSU_HELP_TEXT);
    expect(result.stderr).not.toContain("unrecognized flag");
  });

  it("runs --version without entering the connection controller or picker", () => {
    const launcher = join(__dirname, "..", "scripts", "psu-launcher.mjs");
    const result = spawnSync(process.execPath, [launcher, "--version"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PAPERCUSP_BUILD_ID: "fixture-build",
        PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1",
      },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("psu fixture-build\n");
    expect(result.stderr).not.toMatch(/ECONNREFUSED|connection profile|picker/i);
    expect(PSU_HELP_TEXT).toContain("--version");
  });

  it("reaches recovery redemption without contacting the operator or connection controller", () => {
    const launcher = join(__dirname, "..", "scripts", "psu-launcher.mjs");
    const result = spawnSync(
      process.execPath,
      [launcher, "--recovery-grant=11111111-1111-4111-8111-111111111111"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:1" },
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/native recovery requires a real local terminal/);
    expect(result.stderr).not.toMatch(/ECONNREFUSED|connection profile|retrying/i);
  });

  it("defaults to the interactive picker", () => {
    expect(parseArgs([])).toEqual({
      picker: true,
      resume: false,
      resumeId: null,
      fork: false,
      agent: null,
      role: null,
      stack: [],
      selectedIdentityRevision: null,
      feature: null,
      workspace: null,
      harness: null,
      plan: null,
      noPlan: false,
      model: null,
      resumeSession: null,
      launchContext: null,
      launchedBy: null,
      ownerId: null,
      profile: null,
      // drain-mode P-003: named operating mode, default none.
      mode: null,
      // agent-allocation P-005: delegated seat template ref, default none.
      seat: null,
      // su-context-size-variants (WI-1282): defaults to null (each client's native default).
      contextSize: null,
      personaTier: null,
      force: false,
      yes: false,
      brain: false,
      carry: null,
      account: null,
      fleet: null,
      fleetRole: null,
      fleetRoleRequested: null,
      fleetName: null,
      fleetScheme: null,
      headless: false,
      // fleet-auto-mode (WI-1356): null = no explicit --auto/--no-auto (effective
      // default derived from --fleet by effectiveAutoMode).
      auto: null,
      addDir: [],
      passthrough: [],
      setClaudeToken: false,
      setClaudeTokenValue: null,
      clearClaudeToken: false,
      recoveryAuthorize: false,
      recoveryGrant: null,
      recoveryReason: null,
      recoveryTtlMs: null,
      recoveryMaxRuntimeMs: null,
      compactionLimit: null,
      terminalCheck: false,
      // subagent-launch governance (owner mandate 2026-07-02): tri-state, default
      // null (unset) — the picker prompts (falling back to DENY); a flag preselects.
      allowSubagents: null,
      kickoffPromptText: null,
      label: null,
      tui: null,
    });
  });

  it("parses the PUI caller origin and supports the space form", () => {
    expect(parseArgs(["--tui=pui"]).tui).toBe(PUI_TUI_ORIGIN);
    expect(parseArgs(["--tui", "pui"]).tui).toBe(PUI_TUI_ORIGIN);
    expect(() => parseArgs(["--tui=desktop"])).toThrow(/only supported caller origin/i);
  });

  it("exposes PUI exactly once and filters it for PUI-originated launches", () => {
    expect(agentPickerChoices().map((choice) => choice.value)).toEqual([
      "claude",
      "omp",
      "codex",
      "pui",
    ]);
    expect(agentPickerChoices({ tui: PUI_TUI_ORIGIN }).map((choice) => choice.value)).toEqual([
      "claude",
      "omp",
      "codex",
    ]);
    expect(puiWorkbenchCommand()).toEqual({ bin: "pui", args: ["workbench"] });
    expect(PSU_HELP_TEXT).toContain("--tui=<pui>");
  });

  it("launches PUI with the exact workbench command and preserves child status", () => {
    const calls: unknown[] = [];
    const status = launchPuiWorkbench({
      cwd: "/tmp/pui-test",
      env: { PATH: "/bin" },
      spawnImpl: (...args: unknown[]) => {
        calls.push(args);
        return { status: 7, signal: null, error: undefined };
      },
    });
    expect(status).toBe(7);
    expect(calls).toEqual([
      ["pui", ["workbench"], { cwd: "/tmp/pui-test", env: { PATH: "/bin" }, stdio: "inherit" }],
    ]);
  });

  it("keeps PUI outside the PSU command surface", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseArgs(["--client=pui"])).not.toHaveProperty("client");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("unrecognized flag"),
      );
    } finally {
      spy.mockRestore();
    }
    expect(PSU_HELP_TEXT).not.toContain("--client");
    const launcher = readFileSync(
      join(__dirname, "..", "scripts", "psu-launcher.mjs"),
      "utf8",
    );
    expect(launcher).not.toContain("resolveInteractiveClient");
    expect(launcher).not.toContain("puiClientCommand");
  });

  it("parses --allow-subagents / --no-subagents (owner mandate 2026-07-02); defaults null (⇒ deny)", () => {
    expect(parseArgs([]).allowSubagents).toBeNull();
    expect(parseArgs(["--allow-subagents"]).allowSubagents).toBe(true);
    expect(parseArgs(["--no-subagents"]).allowSubagents).toBe(false);
  });

  it("parses --headless (headless-fleet-launch P-001); defaults false and implies --no-picker", () => {
    expect(parseArgs([]).headless).toBe(false);
    expect(parseArgs([]).picker).toBe(true);
    const a = parseArgs([
      "--headless",
      "--agent=claude",
      "--harness=x",
      "--plan=p",
    ]);
    expect(a.headless).toBe(true);
    // No terminal to prompt at — headless forces the scripted (non-picker) path.
    expect(a.picker).toBe(false);
  });

  it("parses retired --brain as a tombstoned flag, not a backend-specific capability", () => {
    expect(parseArgs(["--brain"]).brain).toBe(true);
    expect(parseArgs([]).brain).toBe(false);
    const both = parseArgs(["--brain", "--model=opus"]);
    expect(both.brain).toBe(true);
    // opus is a default-1M family → parseArgs normalizes the spec to carry [1m]
    // (owner directive 2026-07-02; see the normalizeModelSpec suite below).
    expect(both.model).toBe("opus[1m]");
    expect(BRAIN_TOMBSTONE_MESSAGE).toMatch(/operator\/sentinel converse/i);
  });

  it("parses the scripting-escape flags", () => {
    expect(
      parseArgs([
        "--no-picker",
        "--agent=claude",
        "--workspace=ws1",
        "--harness=papercup",
        "--plan=my-plan",
      ]),
    ).toEqual({
      picker: false,
      resume: false,
      resumeId: null,
      fork: false,
      agent: "claude",
      role: null,
      stack: [],
      selectedIdentityRevision: null,
      feature: null,
      workspace: "ws1",
      harness: "papercup",
      plan: "my-plan",
      noPlan: false,
      model: null,
      resumeSession: null,
      launchContext: null,
      launchedBy: null,
      ownerId: null,
      profile: null,
      mode: null,
      seat: null,
      contextSize: null,
      personaTier: null,
      force: false,
      yes: false,
      brain: false,
      carry: null,
      account: null,
      fleet: null,
      fleetRole: null,
      fleetRoleRequested: null,
      fleetName: null,
      fleetScheme: null,
      headless: false,
      auto: null,
      addDir: [],
      passthrough: [],
      setClaudeToken: false,
      setClaudeTokenValue: null,
      clearClaudeToken: false,
      recoveryAuthorize: false,
      recoveryGrant: null,
      recoveryReason: null,
      recoveryTtlMs: null,
      recoveryMaxRuntimeMs: null,
      compactionLimit: null,
      terminalCheck: false,
      allowSubagents: null,
      kickoffPromptText: null,
      label: null,
      tui: null,
    });
  });

  it("parses bounded native-recovery authorization and redemption flags", () => {
    expect(parseArgs([
      "--recovery-authorize",
      "--recovery-reason", "operator endpoint unavailable",
      "--recovery-ttl=120",
      "--recovery-max-runtime=15",
      "--", "printf", "%s", "offline-ok",
    ])).toMatchObject({
      recoveryAuthorize: true,
      recoveryReason: "operator endpoint unavailable",
      recoveryTtlMs: 120_000,
      recoveryMaxRuntimeMs: 15_000,
      passthrough: ["printf", "%s", "offline-ok"],
    });
    expect(parseArgs(["--recovery-grant=1234"]).recoveryGrant).toBe("1234");
    expect(() => parseArgs(["--recovery-ttl=1.5"])).toThrow(/whole number/);
  });

  it("parses repeatable identity stack refs in equals and space forms", () => {
    expect(parseArgs(["--stack=domain:researcher", "--stack", "practice:concise"]).stack).toEqual([
      "domain:researcher",
      "practice:concise",
    ]);
  });

  it("parses --resume (picker mode — no id)", () => {
    const a = parseArgs(["--resume"]);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBeNull();
  });

  it("parses --resume=<id> (direct, skip picker)", () => {
    const a = parseArgs(["--resume=42"]);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe("42");
  });

  it("parses a bare positional id after --resume", () => {
    const a = parseArgs(["--resume", "57"]);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe("57");
  });

  it("parses --no-plan", () => {
    expect(
      parseArgs(["--no-picker", "--agent=omp", "--harness=x", "--no-plan"])
        .noPlan,
    ).toBe(true);
  });

  it("parses --account (psu-account-chooser; both = and space forms; default null)", () => {
    expect(parseArgs([]).account).toBeNull();
    expect(parseArgs(["--account=aviynw6"]).account).toBe("aviynw6");
    expect(parseArgs(["--account", "aviynw6"]).account).toBe("aviynw6");
    // Composable with the other launch flags + the `--` passthrough is untouched.
    const a = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--account",
      "avi-storewolf",
      "--",
      "--verbose",
    ]);
    expect(a.account).toBe("avi-storewolf");
    expect(a.agent).toBe("claude");
    expect(a.passthrough).toEqual(["--verbose"]);
  });

  it("parses --profile (P-023); defaults to null", () => {
    expect(parseArgs(["--profile=power"]).profile).toBe("power");
    expect(parseArgs(["--agent=claude"]).profile).toBeNull();
  });

  it("EI-181: accepts the space-separated form of --role/--agent/--workspace/--feature/--harness/--plan (repro: `psu --role operator` used to silently resolve to null)", () => {
    expect(parseArgs(["--role", "operator"]).role).toBe("operator");
    expect(parseArgs(["--agent", "claude"]).agent).toBe("claude");
    expect(parseArgs(["--workspace", "ws1"]).workspace).toBe("ws1");
    expect(parseArgs(["--feature", "F-123"]).feature).toBe("F-123");
    expect(parseArgs(["--harness", "papercusp"]).harness).toBe("papercusp");
    expect(parseArgs(["--plan", "my-plan"]).plan).toBe("my-plan");
    // The exact repro from the item body — the space form must be equivalent to `=`.
    const spaceForm = parseArgs([
      "--no-picker",
      "--role",
      "operator",
      "--agent=claude",
    ]);
    const eqForm = parseArgs([
      "--no-picker",
      "--role=operator",
      "--agent=claude",
    ]);
    expect(spaceForm.role).toBe(eqForm.role);
    expect(spaceForm.role).toBe("operator");
    // Composes with the `--` passthrough — the value is consumed, not treated as a flag.
    const withPassthrough = parseArgs([
      "--role",
      "operator",
      "--",
      "--verbose",
    ]);
    expect(withPassthrough.role).toBe("operator");
    expect(withPassthrough.passthrough).toEqual(["--verbose"]);
  });

  it("EI-181: warns (never throws) on a genuinely unrecognized `--` flag instead of silently dropping it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = parseArgs([
        "--no-picker",
        "--agent=claude",
        "--totally-not-a-real-flag",
      ]);
      expect(a.agent).toBe("claude"); // the rest of the parse is unaffected
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain("--totally-not-a-real-flag");
    } finally {
      spy.mockRestore();
    }
  });

  it("parses trimmed and normalizes the legacy full spelling", () => {
    expect(parseArgs(["--context-size=trimmed"]).contextSize).toBe("trimmed");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const legacy = parseArgs(["--context-size=full"]);
    expect(legacy.contextSize).toBe("trimmed");
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/full is retired.*trimmed/i));
    spy.mockRestore();
    expect(parseArgs(["--agent=claude"]).contextSize).toBeNull();
  });

  it("parses --yes / -y (untracked-resume confirm bypass); defaults false", () => {
    expect(parseArgs(["--resume=x", "--yes"]).yes).toBe(true);
    expect(parseArgs(["--resume=x", "-y"]).yes).toBe(true);
    expect(parseArgs(["--resume=x"]).yes).toBe(false);
  });

  it("parses --add-dir (space + = forms, repeatable); defaults to []", () => {
    expect(parseArgs([]).addDir).toEqual([]);
    expect(parseArgs(["--add-dir", "/tmp/a"]).addDir).toEqual(["/tmp/a"]);
    expect(parseArgs(["--add-dir=/tmp/b"]).addDir).toEqual(["/tmp/b"]);
    // Repeatable, both forms intermixed.
    expect(
      parseArgs(["--add-dir", "/x", "--add-dir=/y", "--add-dir", "/z"]).addDir,
    ).toEqual(["/x", "/y", "/z"]);
    // An empty `--add-dir=` contributes nothing.
    expect(parseArgs(["--add-dir="]).addDir).toEqual([]);
  });

  it("a value after --add-dir is taken verbatim, not parsed as a psu flag", () => {
    // The space-form value is consumed as the dir even if it looks flag-ish.
    const a = parseArgs(["--add-dir", "--no-plan"]);
    expect(a.addDir).toEqual(["--no-plan"]);
    expect(a.noPlan).toBe(false);
  });

  it("--add-dir before `--` is psu-parsed; after `--` it is verbatim passthrough", () => {
    const a = parseArgs(["--add-dir", "/early", "--", "--add-dir", "/late"]);
    expect(a.addDir).toEqual(["/early"]);
    expect(a.passthrough).toEqual(["--add-dir", "/late"]);
  });

  it("parses --auto / --no-auto (fleet-auto-mode WI-1356); defaults null", () => {
    expect(parseArgs([]).auto).toBeNull();
    expect(parseArgs(["--auto"]).auto).toBe(true);
    expect(parseArgs(["--no-auto"]).auto).toBe(false);
    // last one wins if both are (nonsensically) passed
    expect(parseArgs(["--auto", "--no-auto"]).auto).toBe(false);
  });

  it("parses DRAIN/GRADE/TEST and refuses unknown modes loudly", () => {
    expect(parseArgs([]).mode).toBeNull();
    expect(parseArgs(["--mode=drain"]).mode).toBe("drain");
    expect(parseArgs(["--mode=grade"]).mode).toBe("grade");
    expect(parseArgs(["--mode=test"]).mode).toBe("test");
    // A typo'd mode must fail the launch, not silently launch a plain session.
    expect(() => parseArgs(["--mode=burndown"])).toThrow(/not recognized/);
    expect(() => parseArgs(["--mode="])).toThrow(/not recognized/);
  });

  it("parses and bounds the propagated DRAIN subject/instructions payload", () => {
    const args = parseArgs([
      "--mode=drain",
      "--mode-subject=  bug-drain  ",
      "--mode-instructions=  checkpoint incidental defects  ",
      "--mode-owner-directed",
    ]);
    expect(args.modeSubject).toBe("  bug-drain  ");
    expect(args.modeInstructions).toBe("  checkpoint incidental defects  ");
    expect(args.modeOwnerDirected).toBe(true);
    expect(launchModeFromArgs(args)).toEqual({
      mode: "drain",
      subject: "bug-drain",
      instructions: "checkpoint incidental defects",
      ownerDirected: true,
    });
    expect(
      launchModeFromArgs({
        mode: "drain",
        modeSubject: ` ${"s".repeat(240)} `,
        modeInstructions: ` ${"i".repeat(540)} `,
      }),
    ).toEqual({
      mode: "drain",
      subject: "s".repeat(200),
      instructions: "i".repeat(500),
      ownerDirected: false,
    });
  });

  it("drain-mode P-003: DRAIN implies AUTO — effectiveAutoMode true even against --no-auto", () => {
    expect(effectiveAutoMode(parseArgs(["--mode=drain"]))).toBe(true);
    // Not overridable: a non-auto drain is a contradiction.
    expect(effectiveAutoMode(parseArgs(["--mode=drain", "--no-auto"]))).toBe(
      true,
    );
    // Baseline unchanged without the flag.
    expect(effectiveAutoMode(parseArgs(["--no-auto"]))).toBe(false);
    expect(effectiveAutoMode(parseArgs([]))).toBe(false);
  });

  it('launches GRADE and TEST autonomously with their named mode in the bootstrap body', () => {
    for (const mode of ['grade', 'test']) {
      const args = parseArgs([`--mode=${mode}`]);
      expect(effectiveAutoMode(args)).toBe(true);
      expect(launchModeFromArgs(args)?.mode).toBe(mode);
    }
  });

  it("parses --fork / --fork-session (resume-time branch); defaults false", () => {
    expect(parseArgs(["--resume=42", "--fork"]).fork).toBe(true);
    expect(parseArgs(["--resume=42", "--fork-session"]).fork).toBe(true);
    expect(parseArgs(["--resume=42"]).fork).toBe(false);
  });

  it("collects everything after a literal `--` as verbatim passthrough", () => {
    const a = parseArgs([
      "--resume=42",
      "--",
      "--add-dir",
      "/tmp",
      "--foo=bar",
    ]);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe("42");
    expect(a.passthrough).toEqual(["--add-dir", "/tmp", "--foo=bar"]);
  });

  it("does NOT parse psu flags that appear after `--` — they are forwarded", () => {
    // `--no-picker` past the `--` is the backend CLI's to interpret, not psu's.
    const a = parseArgs(["--resume=42", "--", "--no-picker"]);
    expect(a.picker).toBe(true);
    expect(a.passthrough).toEqual(["--no-picker"]);
  });

  it("resumeArgsFor maps each agent to its RAW CLI + resume args (P-042, no wrapper)", () => {
    expect(resumeArgsFor({ agent: "claude", cwd: "/x" })).toEqual({
      bin: "claude",
      // Subagent deny is re-armed by DEFAULT on every claude resume (owner mandate 2026-07-02).
      args: [
        "--continue",
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        NO_SUBAGENTS_DENY_FLAG,
        NATIVE_TOOL_SEARCH_DENY_FLAG,
        OWNER_DESKTOP_NOTIFY_DENY_FLAG,
        // Re-armed on RESUME too (P-006): a spawn-time deny does not persist
        // into a resume, so without this a resumed su session silently regains
        // 9,156 B of scheduler-tool schemas per turn.
        SU_SCHEDULER_TOOLS_DENY_FLAG,
        NATIVE_DEADWEIGHT_DENY_FLAG,
        NO_CHROME_FLAG,
      ],
    });
    // omp: thread target (or -c) + yolo; -e only when a coordExtPath is supplied.
    // `--no-lsp` is present because omp CLI flags do NOT persist into a resume,
    // so the native-lsp gate must be re-applied every time (P-023/D-015). With
    // no model spec the tier term fails closed — see the dedicated block below.
    expect(
      resumeArgsFor({ agent: "omp", cwd: "/x", ompThreadId: "thr-1" }),
    ).toEqual({
      bin: "omp",
      args: ["-r", "thr-1", "--approval-mode", "yolo", "--no-title", "--no-lsp"],
    });
    expect(
      resumeArgsFor(
        { agent: "omp", cwd: "/x", ompThreadId: null },
        { coordExtPath: "/h/.papercusp/papercusp-coord.ts" },
      ),
    ).toEqual({
      bin: "omp",
      args: [
        "-c",
        "--approval-mode",
        "yolo",
        "-e",
        "/h/.papercusp/papercusp-coord.ts",
        "--no-title",
        "--no-lsp",
      ],
    });
    expect(
      resumeArgsFor(
        { agent: "codex", cwd: "/x" },
        { model: "gpt-5.6-sol:xhigh" } as unknown as Parameters<
          typeof resumeArgsFor
        >[1],
      ),
    ).toEqual({
      bin: "codex",
      args: [
        "--dangerously-bypass-hook-trust",
        "--dangerously-bypass-approvals-and-sandbox",
        "--no-alt-screen",
        "-m",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-c",
        "model_context_window=1000000",
        "-c",
        "model_auto_compact_token_limit=900000",
        "resume",
        "--last",
      ],
    });
    expect(() => resumeArgsFor({ agent: "gemini", cwd: "/x" })).toThrow();
  });

  /**
   * P-023 (D-015) — the omp native-`lsp` gate on the RESUME path.
   *
   * omp CLI flags do not persist into a resume, so a gate applied only at fresh
   * launch is not applied at all after the first resume. Before P-023 this
   * branch never emitted `--no-lsp`, so every resumed omp session kept the
   * builtin unconditionally — including sessions on weak LOCAL models, which is
   * the population the tier gate exists to exclude.
   *
   * These assertions call the real function, so they fail if the fix is
   * reverted — unlike the structural guards in omp-native-lsp-gate.test.ts,
   * which can only read the launcher's source.
   */
  describe("resumeArgsFor re-applies the omp native-lsp gate (P-023)", () => {
    // psu-launcher.mjs is untyped JS, so TS infers resumeArgsFor's options as
    // `{ model?: null }` from its `model = null` default — a string spec, which
    // is the real runtime contract, does not fit. Cast once at the boundary
    // rather than leave three raw errors: `lint:tsc:operator` is a PER-FILE
    // baseline gate and a green-checkpoint leg, so new errors in this file fail
    // the gate even though the file carries a large recorded baseline.
    type ResumeOpts = Parameters<typeof resumeArgsFor>[1];
    const withModel = (model: string | null) =>
      ({ model }) as unknown as ResumeOpts;

    const resumeOmp = (model: string | null) =>
      resumeArgsFor(
        { agent: "omp", cwd: "/x", ompThreadId: "thr-1" },
        withModel(model),
      ).args;

    it("a LOCAL model STRIPS the builtin — the case the hole exposed", () => {
      for (const model of [
        "ornith",
        "ollama/llama3",
        "ornith:fast",
        "ornith[1m]",
      ]) {
        expect(resumeOmp(model)).toContain("--no-lsp");
      }
    });

    it("an UNKNOWN model strips too — omp would fall back to its local default", () => {
      // Fail-closed. `psu --resume` without an explicit --model is the common
      // case, and "we were not told" is not evidence the model is safe.
      expect(resumeOmp(null)).toContain("--no-lsp");
    });

    it("a CLOUD model KEEPS it — proving the gate can also say yes", () => {
      // Without this the block above would pass just as well against a branch
      // that hard-coded '--no-lsp' unconditionally, which is not the contract.
      for (const model of ["sonnet:medium", "gpt-5.5:high", "fable[1m]"]) {
        expect(resumeOmp(model)).not.toContain("--no-lsp");
      }
    });

    it("non-omp resumes never carry the flag — the builtin is omp-only", () => {
      expect(
        resumeArgsFor({ agent: "claude", cwd: "/x" }, withModel("ornith")).args,
      ).not.toContain("--no-lsp");
      expect(
        resumeArgsFor({ agent: "codex", cwd: "/x" }, withModel("ornith")).args,
      ).not.toContain("--no-lsp");
    });
  });

  it("resumeArgsFor uses precise resume-by-id when a native sessionId is known", () => {
    // Store-found (untracked) sessions carry the agent's native id → resume EXACTLY it.
    expect(
      resumeArgsFor({ agent: "claude", sessionId: "uuid-1" }).args,
    ).toEqual([
      "--resume",
      "uuid-1",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
    ]);
    expect(resumeArgsFor(
      { agent: "codex", sessionId: "uuid-2" },
      { model: "gpt-5.6-sol:xhigh" } as unknown as Parameters<typeof resumeArgsFor>[1],
    ).args).toEqual(
      [
        "--dangerously-bypass-hook-trust",
        "--dangerously-bypass-approvals-and-sandbox",
        "--no-alt-screen",
        "-m",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-c",
        "model_context_window=1000000",
        "-c",
        "model_auto_compact_token_limit=900000",
        "resume",
        "uuid-2",
      ],
    );
  });

  it("resumeArgsFor appends --fork-session for a claude fork (branch, leave the original)", () => {
    expect(
      resumeArgsFor({ agent: "claude", sessionId: "uuid-1" }, { fork: true })
        .args,
    ).toEqual([
      "--resume",
      "uuid-1",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
      "--fork-session",
    ]);
    // Fork also composes with the most-recent (--continue) resume.
    expect(resumeArgsFor({ agent: "claude" }, { fork: true }).args).toEqual([
      "--continue",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
      "--fork-session",
    ]);
  });

  it("resumeArgsFor maps Codex --fork to native codex fork, and still refuses OMP", () => {
    expect(() =>
      resumeArgsFor({ agent: "omp", ompThreadId: "t" }, { fork: true }),
    ).toThrow(/launch-context/);
    expect(
      resumeArgsFor(
        { agent: "codex", sessionId: "uuid-2" },
        { fork: true, model: "gpt-5.6-sol:xhigh" } as unknown as Parameters<typeof resumeArgsFor>[1],
      )
        .args,
    ).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      "model_context_window=1000000",
      "-c",
      "model_auto_compact_token_limit=900000",
      "fork",
      "uuid-2",
    ]);
    expect(resumeArgsFor(
      { agent: "codex" },
      { fork: true, model: "gpt-5.6-sol:xhigh" } as unknown as Parameters<typeof resumeArgsFor>[1],
    ).args).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      "model_context_window=1000000",
      "-c",
      "model_auto_compact_token_limit=900000",
      "fork",
      "--last",
    ]);
  });

  it("Codex SU forks bind Papercusp MCP to the fresh owner without changing CODEX_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-fork-mcp-"));
    const configPath = join(home, "config.toml");
    const sourceUrl =
      "http://localhost:3070/api/mcp?superuser=1&client=su-source";
    const configText =
      '[mcp_servers."papercusp-su"]\nurl = ' +
      JSON.stringify(sourceUrl) +
      "\n";
    try {
      writeFileSync(configPath, configText);
      const before = readFileSync(configPath);
      const forkUrl = codexForkMcpUrlForOwner(home, "su-fork");
      expect(forkUrl).toBeTruthy();
      if (!forkUrl) throw new Error("expected a fork-specific MCP URL");

      const parsed = new URL(forkUrl);
      expect(parsed.searchParams.get("client")).toBe("su-fork");
      expect(parsed.searchParams.get("superuser")).toBe("1");

      const forkArgs = resumeArgsFor(
        { agent: "codex", sessionId: "source-session" },
        {
          fork: true,
          codexMcpUrl: forkUrl,
          model: "gpt-5.6-sol",
        } as unknown as Parameters<
          typeof resumeArgsFor
        >[1],
      ).args;
      expect(forkArgs.slice(0, 2)).toEqual([
        "-c",
        "mcp_servers.papercusp-su.url=" + JSON.stringify(forkUrl),
      ]);
      expect(forkArgs).toContain("fork");
      expect(forkArgs).toContain("source-session");

      const resumeArgs = resumeArgsFor(
        { agent: "codex", sessionId: "source-session" },
        {
          codexMcpUrl: forkUrl,
          model: "gpt-5.6-sol",
        } as unknown as Parameters<
          typeof resumeArgsFor
        >[1],
      ).args;
      expect(resumeArgs).not.toContain(
        "mcp_servers.papercusp-su.url=" + JSON.stringify(forkUrl),
      );
      expect(readFileSync(configPath)).toEqual(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("forkUnsupportedMessage documents the safe non-native fallback for OMP", () => {
    expect(forkUnsupportedMessage("omp")).toContain(
      "psu --agent=omp --launch-context=<brief.md>",
    );
    expect(forkUnsupportedMessage("omp")).toContain("will not silently append");
  });

  it("resumeArgsFor forces the fork id via --session-id ONLY alongside --fork-session (tracked fork)", () => {
    // The plain --session-id/--resume conflict is lifted by --fork-session, so the
    // trio is valid — this is how launchTrackedFork pins the fork to a psu-minted id.
    expect(
      resumeArgsFor(
        { agent: "claude", sessionId: "orig" },
        { fork: true, forkSessionId: "forked" },
      ).args,
    ).toEqual([
      "--resume",
      "orig",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
      "--fork-session",
      "--session-id",
      "forked",
    ]);
    // forkSessionId WITHOUT fork is ignored (no --fork-session ⇒ --session-id would conflict with --resume).
    expect(
      resumeArgsFor(
        { agent: "claude", sessionId: "orig" },
        { forkSessionId: "forked" },
      ).args,
    ).toEqual([
      "--resume",
      "orig",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
    ]);
  });

  it("addDirArgs maps to each backend native flag (claude/codex), [] for omp; uses the greed-safe = form", () => {
    expect(addDirArgs("claude", ["/a", "/b"])).toEqual([
      "--add-dir=/a",
      "--add-dir=/b",
    ]);
    expect(addDirArgs("codex", ["/a"])).toEqual(["--add-dir=/a"]);
    expect(addDirArgs("omp", ["/a"])).toEqual([]); // omp has no --add-dir
    expect(addDirArgs("claude", [])).toEqual([]);
    expect(addDirArgs("gemini", ["/a"])).toEqual([]); // unknown backend
  });

  it("resumeArgsFor threads --add-dir into each backend at the right position", () => {
    // claude: appended after the resume/permission flags.
    expect(
      resumeArgsFor({ agent: "claude", sessionId: "u" }, { addDir: ["/d"] })
        .args,
    ).toEqual([
      "--resume",
      "u",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
      "--add-dir=/d",
    ]);
    // claude fork: --add-dir comes after the fork flags.
    expect(
      resumeArgsFor(
        { agent: "claude", sessionId: "orig" },
        { fork: true, forkSessionId: "f", addDir: ["/d"] },
      ).args,
    ).toEqual([
      "--resume",
      "orig",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
      "--fork-session",
      "--session-id",
      "f",
      "--add-dir=/d",
    ]);
    // codex: --add-dir is a TOP-LEVEL option, so it must precede the `resume` subcommand.
    expect(
      resumeArgsFor(
        { agent: "codex", sessionId: "u" },
        { addDir: ["/d"], model: "gpt-5.6-sol:xhigh" } as unknown as Parameters<
          typeof resumeArgsFor
        >[1],
      )
        .args,
    ).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      "model_context_window=1000000",
      "-c",
      "model_auto_compact_token_limit=900000",
      "--add-dir=/d",
      "resume",
      "u",
    ]);
    expect(
      resumeArgsFor(
        { agent: "codex", sessionId: "u" },
        {
          fork: true,
          addDir: ["/d"],
          model: "gpt-5.6-sol:xhigh",
        } as unknown as Parameters<typeof resumeArgsFor>[1],
      ).args,
    ).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      "model_context_window=1000000",
      "-c",
      "model_auto_compact_token_limit=900000",
      "--add-dir=/d",
      "fork",
      "u",
    ]);
  });

  it("forkBootstrapBody carries the original workspace/plan + cwd, harness null, agent claude", () => {
    expect(
      forkBootstrapBody({
        agent: "claude",
        sessionId: "orig",
        coordOwnerId: "su-1",
        id: 7,
        workspaceId: "ws9",
        planSlug: "my-plan",
        cwd: "/repo",
      }),
    ).toEqual({
      agent: "claude",
      workspace: "ws9",
      harness_slug: null,
      plan_slug: "my-plan",
      cwd: "/repo",
    });
    // Missing optional fields collapse to null.
    expect(forkBootstrapBody({ agent: "claude", cwd: "/repo" })).toEqual({
      agent: "claude",
      workspace: null,
      harness_slug: null,
      plan_slug: null,
      cwd: "/repo",
    });
  });

  it("forkBootstrapBody folds a chosen account so the server re-pins the gateway (byte-identical when omitted)", () => {
    // A tracked fork mints a fresh session, so the account pin is resolved
    // server-side (resolveAccountPin) — the launcher only forwards the chosen id.
    expect(
      forkBootstrapBody({ agent: "claude", cwd: "/repo" }, "aviynw6"),
    ).toEqual({
      agent: "claude",
      workspace: null,
      harness_slug: null,
      plan_slug: null,
      cwd: "/repo",
      account: "aviynw6",
    });
    // No account → NO `account` key at all (byte-identical to the pre-account body).
    expect(
      forkBootstrapBody({ agent: "claude", cwd: "/repo" }, null),
    ).not.toHaveProperty("account");
  });

  it("fork fallback preserves the complete route decision for config-carried backends", () => {
    expect(
      forkFallbackAccountRoute({
        mode: "pin",
        id: "codex-main",
        provider: "codex",
        env: { PAPERCUSP_ACCOUNT_ID: "codex-main" },
        notice: "pinned",
      }),
    ).toMatchObject({
      mode: "pin",
      id: "codex-main",
      provider: "codex",
      env: { PAPERCUSP_ACCOUNT_ID: "codex-main" },
    });
    expect(
      forkFallbackAccountRoute({
        mode: "auto",
        forward: "auto",
        env: {},
        notice: null,
      }),
    ).toMatchObject({ mode: "auto", forward: "auto", env: {} });
    expect(
      forkFallbackAccountRoute({
        mode: "default",
        id: null,
        env: defaultAccountEnv(),
        notice: null,
      }),
    ).toMatchObject({ mode: "default", id: null, env: defaultAccountEnv() });
  });

  it.each([
    { name: "agent-launched headless", launchedBy: "su-parent", headless: true },
    { name: "human-launched visible", launchedBy: null, headless: false },
  ])("records $name fork provenance in the actual bootstrap request", async ({ launchedBy, headless }) => {
    const source = {
      agent: "claude", sessionId: "native-source", coordOwnerId: "su-source",
      id: 17, cwd: "/repo", workspaceId: "fork-workspace", planSlug: "source-plan",
      portId: "inherited-port", portSourceAdvSessionId: 11,
    };
    const postBootstrap = vi.fn().mockRejectedValue(new Error("stop after captured request"));
    const launchResume = vi.fn();
    await expect(launchTrackedFork(source, {
      ownerId: "su-fork", launchedBy, headless, contextSize: "trimmed",
      sessionPortSourceAdvSessionId: source.id,
      sessionPortToken: "inherited-port-token", sessionPortProtocol: 1,
    }, { forward: "auto", id: null, env: {}, notice: null }, "fable[1m]", {
      api: postBootstrap, launchResume,
    })).rejects.toThrow(/pre-pinned managed identity requires a launch record/);
    const body = JSON.parse(postBootstrap.mock.calls[0]![1].body);
    expect(body.launch_argv).toEqual(expect.arrayContaining([
      "--resume=native-source", "--fork", "--owner-id=su-fork",
      "--agent=claude", "--workspace=fork-workspace", "--plan=source-plan",
      "--account=auto", "--model=fable[1m]",
    ]));
    expect(body.owner_id).toBe("su-fork");
    expect(body.launch_argv.filter((arg: string) => /^--resume(?:=|$)/.test(arg)))
      .toEqual(["--resume=native-source"]);
    expect(body.launch_argv.some((arg: string) => arg.startsWith("--session-port"))).toBe(false);
    for (const key of ["session_port_token", "session_port_protocol", "session_port_source_adv_session_id"]) {
      expect(body).not.toHaveProperty(key);
    }
    if (launchedBy) {
      expect(body.launched_by).toBe(launchedBy);
      expect(body.launch_argv).toContain(`--launched-by=${launchedBy}`);
    } else {
      expect(body).not.toHaveProperty("launched_by");
      expect(body.launch_argv.some((arg: string) => arg.startsWith("--launched-by="))).toBe(false);
    }
    expect(body.headless === true).toBe(headless);
    expect(body.launch_argv.includes("--headless")).toBe(headless);
    expect(launchResume).not.toHaveBeenCalled();
  });

  it("pre-pinned managed forks fail closed instead of launching without a record", async () => {
    const source = {
      agent: "claude",
      sessionId: "native-source",
      coordOwnerId: "su-source",
      id: 17,
      cwd: "/repo",
    };
    const account = { id: null, env: {}, notice: null };
    const bootstrapFailures = [
      vi.fn().mockRejectedValue(new Error("bootstrap unavailable")),
      vi.fn().mockResolvedValue({ nativeSessionId: null, envelopeEnv: {} }),
    ];

    for (const postBootstrap of bootstrapFailures) {
      const launchResume = vi.fn().mockResolvedValue(undefined);
      await expect(
        launchTrackedFork(source, { ownerId: "su-consult-fork" }, account, null, {
          api: postBootstrap,
          launchResume,
        }),
      ).rejects.toThrow(/pre-pinned managed identity requires a launch record/);
      expect(launchResume).not.toHaveBeenCalled();
    }
  });

  it("keeps unpinned manual fallback, but refuses a pre-pinned unsupported source", async () => {
    const account = { id: null, env: {}, notice: null };
    const launchResume = vi.fn().mockResolvedValue(undefined);
    const postBootstrap = vi.fn().mockRejectedValue(new Error("bootstrap unavailable"));
    const claudeSource = {
      agent: "claude",
      sessionId: "native-source",
      coordOwnerId: "su-source",
      id: 17,
      cwd: "/repo",
    };

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await launchTrackedFork(claudeSource, { headless: true }, account, null, {
        api: postBootstrap,
        launchResume,
      });
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("UNTRACKED fork"));
      expect(launchResume).toHaveBeenCalledOnce();
      expect(launchResume).toHaveBeenCalledWith(
        claudeSource,
        expect.objectContaining({ fork: true, headless: true }),
      );

      const codexSource = { ...claudeSource, agent: "codex" };
      await expect(
        launchTrackedFork(codexSource, { ownerId: "su-consult-fork" }, account, null, {
          api: postBootstrap,
          launchResume,
        }),
      ).rejects.toThrow(/pre-pinned managed identity requires a launch record/);
      expect(launchResume).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps the manual fork warning explicit and refuses untracked managed forks", () => {
    expect(forkBootstrapFallbackMessage(null, "fork bootstrap failed")).toContain("UNTRACKED fork");
    expect(() => forkBootstrapFallbackMessage(" su-consult-fork ", "fork bootstrap failed")).toThrow(
      /untracked fork su-consult-fork/,
    );
  });

  it("freshSuBootstrapBody forwards launch_context so Codex can fold it into AGENTS.md", () => {
    const body = freshSuBootstrapBody(
      { agent: "codex", workspace: "ws1", harness: "h1", plan: "p1" },
      {
        profile: "engineer",
        account: "codex-main",
        launchContext: "/tmp/kickoff.md",
      },
    );
    expect(body).toMatchObject({
      agent: "codex",
      workspace: "ws1",
      harness_slug: "h1",
      plan_slug: "p1",
      profile: "engineer",
      account: "codex-main",
      launch_context: "/tmp/kickoff.md",
    });
  });

  it("freshSuBootstrapBody forwards the selected MCP base only for Codex", () => {
    const selectedMcpBase = "http://127.0.0.1:9071";
    const codex = freshSuBootstrapBody(
      { agent: "codex", workspace: "ws1", harness: null, plan: null },
      {},
      { mcpBaseUrl: selectedMcpBase },
    );
    expect(codex.mcp_base_url).toBe(selectedMcpBase);

    const claude = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: null, plan: null },
      {},
      { mcpBaseUrl: selectedMcpBase },
    );
    expect("mcp_base_url" in claude).toBe(false);
  });

  it("freshSuBootstrapBody carries a stable replay key only when the fresh launcher supplies one", () => {
    const selections = {
      agent: "codex",
      workspace: "ws1",
      harness: "h1",
      plan: "p1",
    };
    const keyed = freshSuBootstrapBody(
      selections,
      {},
      {
        bootstrapIdempotencyKey: "bootstrap-key-1",
      },
    );
    expect(keyed.bootstrap_idempotency_key).toBe("bootstrap-key-1");
    expect(
      "bootstrap_idempotency_key" in freshSuBootstrapBody(selections, {}),
    ).toBe(false);
  });

  it("freshSuBootstrapBody forwards --label so bootstrap-su stamps adv_sessions.label (docs-agent reuse)", () => {
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: null, plan: null },
      { label: "docs-tutor" },
    );
    expect(body.label).toBe("docs-tutor");
    // omitted when not passed (no null noise on the wire)
    const noLabel = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: null, plan: null },
      {},
    );
    expect("label" in noLabel).toBe(false);
  });

  it("launchesOnSuTier/suRoleFor route ONLY su + the allow-listed roles to the su flow (EI-996)", () => {
    // This predicate is the privilege boundary: a role it admits launches with
    // the SUPERUSER MCP tier instead of a role-scoped one. Everything not on the
    // list must still go to roleFlow.
    expect(launchesOnSuTier("su")).toBe(true);
    expect(launchesOnSuTier("planner")).toBe(true);
    for (const role of [
      "worker",
      "scoper",
      "reviewer",
      "architect",
      "validator",
      "documenter",
    ]) {
      expect(launchesOnSuTier(role), `${role} must NOT get the su tier`).toBe(
        false,
      );
      expect(suRoleFor(role)).toBeNull();
    }
    // 'su' takes the same path but carries NO addendum — it is not a su-tier ROLE.
    expect(suRoleFor("su")).toBeNull();
    expect(suRoleFor("planner")).toBe("planner");
  });

  it("freshSuBootstrapBody forwards a su-tier role NAME as su_role, never addendum prose (EI-996)", () => {
    // Owner ask 2026-06-17: a planner should be a full su agent + a few role
    // lines. The launcher sends the NAME; bootstrap-su resolves the text from
    // the built-in su.specialist-planner identity. The wire must never carry the prose
    // itself — this endpoint mints a SUPERUSER-tier prompt, so a free-text field
    // would be an open prompt-injection surface for any loopback caller.
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: null, plan: null },
      { suRole: "planner" },
    );
    expect(body.su_role).toBe("planner");
    expect("role_addendum" in body).toBe(false);
    // A plain su launch stays byte-identical on the wire — no null noise.
    const plainSu = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: null, plan: null },
      { suRole: null },
    );
    expect("su_role" in plainSu).toBe(false);
  });

  it("freshSuBootstrapBody forwards --owner-id so bootstrap-su pre-pins the coord owner (WI-5002/EI-13277 programmatic-spawner contract)", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--no-plan",
      "--headless",
      "--yes",
      "--owner-id=su-sweep-cell-r1-abc123",
    ]);
    expect(args.ownerId).toBe("su-sweep-cell-r1-abc123");
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: null, plan: null },
      args,
    );
    expect(body.owner_id).toBe("su-sweep-cell-r1-abc123");
    expect(body.launch_argv).toContain("--owner-id=su-sweep-cell-r1-abc123");
    // omitted when not passed (no null noise on the wire; server mints as today)
    const noOwner = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: null, plan: null },
      parseArgs(["--no-picker", "--agent=claude", "--no-plan"]),
    );
    expect("owner_id" in noOwner).toBe(false);
  });

  it("freshSuBootstrapBody records the reconstructed psu launch_argv (WI-1343)", () => {
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs(["--no-picker", "--agent=claude", "--harness=h1", "--plan=p1"]),
    );
    expect(body.launch_argv).toEqual([
      "psu",
      "--no-picker",
      "--agent=claude",
      "--workspace=ws1",
      "--harness=h1",
      "--plan=p1",
    ]);
  });

  it("round-trips a selected identity source revision into bootstrap and launch argv", () => {
    const revision = "a".repeat(64);
    const args = parseArgs(["--no-picker", "--agent=claude", "--stack=domain:research-steward",
      `--identity-revision=${revision}`, "--no-plan"]);
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: null }, args,
    );
    expect(body.stack).toEqual(["domain:research-steward"]);
    expect(body.selected_identity_revision).toBe(revision);
    expect(body.launch_argv).toContain(`--identity-revision=${revision}`);
    expect(parseArgs(body.launch_argv.slice(1)).selectedIdentityRevision).toBe(revision);
  });

  it("freshSuBootstrapBody sets auto:true for a --fleet launch, and threads --fleet into launch_argv (WI-1343/WI-1356)", () => {
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: null },
      parseArgs([
        "--no-picker",
        "--agent=claude",
        "--harness=h1",
        "--no-plan",
        "--fleet=shared-hive-testing",
      ]),
    );
    expect(body.auto).toBe(true);
    expect(body.launch_argv).toContain("--fleet=shared-hive-testing");
    expect(body.launch_argv).toContain("--auto");
    expect(body.launch_argv).toContain("--no-plan");
  });

  it("freshSuBootstrapBody forwards explicit --carry to bootstrap and records it (EI-21220636391634536)", () => {
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs([
        "--no-picker",
        "--agent=claude",
        "--harness=h1",
        "--plan=p1",
        "--fleet=f1",
        "--carry=cold",
      ]),
    );
    expect(body.carry).toBe("cold");
    expect(body.launch_argv).toContain("--carry=cold");

    const plain = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs(["--no-picker", "--agent=claude", "--harness=h1", "--plan=p1"]),
    );
    expect(plain).not.toHaveProperty("carry");
  });

  it("freshSuBootstrapBody omits auto for a non-fleet launch, and honours --no-auto on a fleet launch (WI-1356)", () => {
    const plain = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs(["--no-picker", "--agent=claude", "--harness=h1", "--plan=p1"]),
    );
    expect(plain).not.toHaveProperty("auto");
    expect(plain.launch_argv).not.toContain("--auto");

    const optedOut = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs([
        "--no-picker",
        "--agent=claude",
        "--harness=h1",
        "--plan=p1",
        "--fleet=x",
        "--no-auto",
      ]),
    );
    expect(optedOut).not.toHaveProperty("auto");
  });

  it("drain-mode P-003: freshSuBootstrapBody forwards mode:drain + auto:true, and records --mode= in launch_argv", () => {
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs([
        "--no-picker",
        "--agent=claude",
        "--harness=h1",
        "--plan=p1",
        "--mode=drain",
      ]),
    );
    expect(body.mode).toBe("drain");
    expect(body.auto).toBe(true); // DRAIN implies AUTO — server double-enforces
    expect(body.launch_argv).toContain("--mode=drain");
    expect(body.launch_argv).toContain("--auto");

    // No mode ⇒ the field is absent (byte-identical pre-drain body).
    const plain = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs(["--no-picker", "--agent=claude", "--harness=h1", "--plan=p1"]),
    );
    expect(plain).not.toHaveProperty("mode");
  });

  it("propagates bounded DRAIN scope fields through fresh argv/body and tracked fork body", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=h1",
      "--plan=p1",
      "--mode=drain",
      "--mode-subject=bug-drain",
      "--mode-instructions=checkpoint incidental defects",
      "--mode-owner-directed",
    ]);
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      args,
    );
    expect(body).toMatchObject({
      mode: "drain",
      mode_subject: "bug-drain",
      mode_instructions: "checkpoint incidental defects",
      mode_owner_directed: true,
    });
    expect(body.launch_argv).toEqual(
      expect.arrayContaining([
        "--mode=drain",
        "--mode-subject=bug-drain",
        "--mode-instructions=checkpoint incidental defects",
        "--mode-owner-directed",
      ]),
    );
    expect(
      forkBootstrapBody(
        { agent: "claude", workspaceId: "ws1", planSlug: "p1", cwd: "/repo" },
        null,
        launchModeFromArgs(args),
      ),
    ).toMatchObject({
      mode: "drain",
      mode_subject: "bug-drain",
      mode_instructions: "checkpoint incidental defects",
      mode_owner_directed: true,
    });
  });

  it("preserves GOAL bootstrap subject through parse, recorded argv, and bootstrap body without separate AUTO", () => {
    const args = parseArgs([
      "--no-picker", "--agent=claude", "--owner-id=su-new-holder",
      "--goal-bootstrap-subject=goal-123",
    ]);
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: null }, args,
    );
    expect(args.goalBootstrapSubject).toBe("goal-123");
    expect(body.goal_bootstrap_subject).toBe("goal-123");
    expect(body.launch_argv).toContain("--goal-bootstrap-subject=goal-123");
    expect(body).not.toHaveProperty("auto");
    expect(body).not.toHaveProperty("mode");
    expect(() => parseArgs(["--goal-bootstrap-subject="])).toThrow(/non-empty goal id/);
    expect(() => parseArgs(["--goal-bootstrap-subject=goal-123", "--auto"])).toThrow(/without separate AUTO/);
    expect(() => parseArgs(["--goal-bootstrap-subject=goal-123", "--resume=sid-1"])).toThrow(/fresh, fleetless/);
  });

  it("agent-allocation P-005: parseArgs takes --seat=<ref>; freshSuBootstrapBody forwards seat + records --seat= in launch_argv", () => {
    // The missing client leg P-006 caught live (2026-07-03): fleet:launch-on-plan
    // emitted --seat=<ref> but parseArgs dropped it, so bootstrap-su never saw
    // body.seat and consumeSeatAtBoot (mig 487) never recorded — the seat cap
    // was delegated but unenforced.
    expect(parseArgs([]).seat).toBeNull();
    expect(parseArgs(["--seat=haiku:low:AUTO"]).seat).toBe("haiku:low:AUTO");
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs([
        "--no-picker",
        "--agent=claude",
        "--harness=h1",
        "--plan=p1",
        "--fleet=f1",
        "--seat=haiku:low:AUTO",
      ]),
    );
    expect(body.seat).toBe("haiku:low:AUTO");
    expect(body.launch_argv).toContain("--seat=haiku:low:AUTO");

    // No seat ⇒ the field is absent (byte-identical non-seat body).
    const plain2 = freshSuBootstrapBody(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      parseArgs(["--no-picker", "--agent=claude", "--harness=h1", "--plan=p1"]),
    );
    expect(plain2).not.toHaveProperty("seat");
  });

  it("roleBootstrapBody preserves the launch owner and chosen account", () => {
    expect(
      roleBootstrapBody({
        role: "worker",
        agent: "codex",
        workspace: "ws1",
        harness: "h1",
        feature: "F-001",
        plan: null,
        account: "codex-main",
        ownerId: "su-auditor-canonical",
        launchedBy: "system:acceptance-bar-amendment-review",
        bootstrapIdempotencyKey: "role-launch-stable-key",
      }),
    ).toEqual({
      role: "worker",
      agent: "codex",
      workspace: "ws1",
      harness_slug: "h1",
      feature: "F-001",
      plan: null,
      account: "codex-main",
      owner_id: "su-auditor-canonical",
      launched_by: "system:acceptance-bar-amendment-review",
      bootstrap_idempotency_key: "role-launch-stable-key",
      model: CODEX_SAFE_DEFAULT_MODEL,
      model_source: "configured-default",
    });
    expect(
      roleBootstrapBody({
        role: "worker",
        agent: "codex",
        workspace: "ws1",
        harness: "h1",
        feature: "F-001",
        plan: null,
      }),
    ).not.toHaveProperty("account");
  });

  it('roleBootstrapBody forwards only the existing explicit spawn-host route', () => {
    const input = { role: 'judge', agent: 'codex', workspace: 'ws1', harness: 'h1' };
    expect(roleBootstrapBody({ ...input, mcpTarget: 'spawn-host' })).toMatchObject({
      mcp_target: 'spawn-host', role: 'judge', workspace: 'ws1', harness_slug: 'h1',
    });
    expect(roleBootstrapBody(input)).not.toHaveProperty('mcp_target');
    expect(roleBootstrapBody({ ...input, mcpTarget: 'stable' })).not.toHaveProperty('mcp_target');
  });

  it("forkSeedPaths points at the projects/ subtree of each config dir", () => {
    expect(forkSeedPaths("/orig/cfg", "/fork/cfg")).toEqual({
      src: "/orig/cfg/projects",
      dst: "/fork/cfg/projects",
    });
  });

  it("resumeEnvFor: identity + workspace + harness scope SURVIVE a tracked resume", () => {
    // coordOwnerId is re-exported as PAPERCUSP_SID (wake-executor semantics —
    // a fresh SID orphaned the old one's locks/awaits and detached the adv
    // row); workspaceId rides out as PAPERCUSP_WORKSPACE so the MCP url/header
    // carriers re-scope the resumed session. Harness scope comes from the
    // resolved launch spec on the resumable row, not from ambient env.
    expect(
      resumeEnvFor({
        agent: "claude",
        id: 7,
        coordOwnerId: "su-abc",
        workspaceId: "ws1",
        harnessSlug: "papercusp",
      }),
    ).toEqual({
      PAPERCUSP_AGENT: "claude",
      PAPERCUSP_SID: "su-abc",
      PAPERCUSP_WORKSPACE: "ws1",
      PAPERCUSP_HARNESS_SLUG: "papercusp",
      PAPERCUSP_ADV_SESSION_ID: "7",
    });
  });

  it("resumeEnvFor: untracked sessions (no adv row) mint a fresh SID and omit absent fields", () => {
    expect(
      resumeEnvFor({ agent: "omp" }, { mintSid: () => "su-fresh" }),
    ).toEqual({
      PAPERCUSP_AGENT: "omp",
      PAPERCUSP_SID: "su-fresh",
    });
  });

  it("ompTrackedResumeEnv restores both the tracked config root and overriding agent dir", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-omp-resume-"));
    try {
      const root = join(home, ".papercusp", "su-omp-homes", "session-12601");
      mkdirSync(join(root, "agent"), { recursive: true });
      expect(
        ompTrackedResumeEnv({ agent: "omp", id: 12601 }, { home }),
      ).toEqual({
        PI_CONFIG_DIR: join(".papercusp", "su-omp-homes", "session-12601"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
      });
      expect(ompTrackedResumeEnv({ agent: "omp", id: 999 }, { home })).toEqual(
        {},
      );
      expect(
        ompTrackedResumeEnv({ agent: "codex", id: 12601 }, { home }),
      ).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ompTrackedResumeEnv re-heals a stale empty agent.db to the global OAuth store", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-omp-resume-heal-"));
    try {
      const globalAgent = join(home, ".omp", "agent");
      const root = join(home, ".papercusp", "su-omp-homes", "session-42");
      mkdirSync(globalAgent, { recursive: true });
      mkdirSync(join(root, "agent"), { recursive: true });
      writeFileSync(join(globalAgent, "agent.db"), "GLOBAL_XAI_OAUTH");
      writeFileSync(join(root, "agent", "agent.db"), ""); // pre-fix empty real file
      ompTrackedResumeEnv({ agent: "omp", id: 42 }, { home });
      const dst = join(root, "agent", "agent.db");
      expect(lstatSync(dst).isSymbolicLink()).toBe(true);
      expect(readFileSync(dst, "utf8")).toBe("GLOBAL_XAI_OAUTH");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("OMP Anthropic resume route transitions replace auto/pin config and restore direct config on default", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-omp-route-"));
    try {
      const globalAgent = join(home, ".omp", "agent");
      const sessionAgent = join(
        home,
        ".papercusp",
        "su-omp-homes",
        "session-7",
        "agent",
      );
      mkdirSync(globalAgent, { recursive: true });
      mkdirSync(sessionAgent, { recursive: true });
      writeFileSync(
        join(globalAgent, "models.yml"),
        "providers:\n  anthropic:\n    models: []\n",
      );
      const session = {
        agent: "omp",
        id: 7,
        coordOwnerId: "su-omp",
        ompThreadId: "thr",
      };
      const env = ompTrackedResumeEnv(session, { home });

      const autoModel = applyOmpResumeAccountRoute({
        session,
        env,
        accountRoute: { mode: "auto", provider: "claude" },
        model: "claude-bridge/claude-opus-4-8:high",
        home,
      });
      expect(autoModel).toBe("papercusp-gateway/claude-opus-4-8");
      expect(
        readFileSync(join(sessionAgent, "models.yml"), "utf8"),
      ).not.toContain("x-papercusp-account");

      const pinModel = applyOmpResumeAccountRoute({
        session,
        env,
        accountRoute: { mode: "pin", id: "acct-7", provider: "claude" },
        model: autoModel,
        home,
      });
      expect(pinModel).toBe("papercusp-gateway/claude-opus-4-8");
      expect(readFileSync(join(sessionAgent, "models.yml"), "utf8")).toContain(
        '"x-papercusp-account": "acct-7"',
      );

      const directModel = applyOmpResumeAccountRoute({
        session,
        env,
        accountRoute: { mode: "default" },
        model: pinModel,
        home,
      });
      expect(directModel).toBe("anthropic/claude-opus-4-8");
      expect(readFileSync(join(sessionAgent, "models.yml"), "utf8")).toBe(
        "providers:\n  anthropic:\n    models: []\n",
      );
      expect(ompDirectModelForRoute("ollama/ornith")).toBe("ollama/ornith");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("OMP OpenAI resume routes use the Codex pool/OpenAI wire and restore a direct OpenAI selector", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-omp-openai-route-"));
    try {
      const globalAgent = join(home, ".omp", "agent");
      const sessionAgent = join(
        home,
        ".papercusp",
        "su-omp-homes",
        "session-8",
        "agent",
      );
      mkdirSync(globalAgent, { recursive: true });
      mkdirSync(sessionAgent, { recursive: true });
      writeFileSync(
        join(globalAgent, "models.yml"),
        "providers:\n  openai:\n    models: []\n",
      );
      const session = {
        agent: "omp",
        id: 8,
        coordOwnerId: "su-omp-openai",
        ompThreadId: "thr-openai",
      };
      const env = ompTrackedResumeEnv(session, { home });

      const autoModel = applyOmpResumeAccountRoute({
        session,
        env,
        accountRoute: { mode: "auto", provider: "codex" },
        model: "openai-codex/gpt-5.6-terra:xhigh",
        home,
      });
      expect(autoModel).toBe("papercusp-gateway/gpt-5.6-terra");
      const gatewayConfig = readFileSync(
        join(sessionAgent, "models.yml"),
        "utf8",
      );
      expect(gatewayConfig).toContain('baseUrl: "http://127.0.0.1:8788/v1"');
      expect(gatewayConfig).toContain("api: openai-responses");

      const directModel = applyOmpResumeAccountRoute({
        session,
        env,
        accountRoute: { mode: "default" },
        model: autoModel,
        home,
      });
      expect(directModel).toBe("openai/gpt-5.6-terra");
      expect(readFileSync(join(sessionAgent, "models.yml"), "utf8")).toBe(
        "providers:\n  openai:\n    models: []\n",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("OMP resume gateway routes reject incompatible providers and mismatched account pools", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-omp-incompatible-route-"));
    try {
      const globalAgent = join(home, ".omp", "agent");
      const sessionAgent = join(
        home,
        ".papercusp",
        "su-omp-homes",
        "session-9",
        "agent",
      );
      mkdirSync(globalAgent, { recursive: true });
      mkdirSync(sessionAgent, { recursive: true });
      writeFileSync(join(globalAgent, "models.yml"), "providers: {}\n");
      const session = {
        agent: "omp",
        id: 9,
        coordOwnerId: "su-omp-reject",
        ompThreadId: "thr-reject",
      };
      const env = ompTrackedResumeEnv(session, { home });

      expect(() =>
        applyOmpResumeAccountRoute({
          session,
          env,
          accountRoute: { mode: "auto", provider: "claude" },
          model: "amazon-bedrock/anthropic.claude-opus-4-8",
          home,
        }),
      ).toThrow(/not compatible.*refusing model substitution/i);
      expect(() =>
        applyOmpResumeAccountRoute({
          session,
          env,
          accountRoute: { mode: "pin", id: "claude-main", provider: "claude" },
          model: "openai-codex/gpt-5.6-terra",
          home,
        }),
      ).toThrow(/requires codex accounts.*resolved claude/i);
      expect(() =>
        ompDirectModelForRoute("papercusp-gateway/unknown-local-model"),
      ).toThrow(/cannot be restored.*refusing model substitution/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resumeEnvFor: a FORK takes a fresh coord identity + no adv-row link (concurrent-safe)", () => {
    // Even though the source IS a tracked row (coordOwnerId + id present), the fork
    // must NOT inherit its SID or adv id — otherwise it would collide on the still-
    // live original's locks/presence/wakes. Workspace scope still carries over.
    expect(
      resumeEnvFor(
        {
          agent: "claude",
          id: 7,
          coordOwnerId: "su-abc",
          workspaceId: "ws1",
          harnessSlug: "papercusp",
        },
        { mintSid: () => "su-fork", fork: true },
      ),
    ).toEqual({
      PAPERCUSP_AGENT: "claude",
      PAPERCUSP_SID: "su-fork",
      PAPERCUSP_WORKSPACE: "ws1",
      PAPERCUSP_HARNESS_SLUG: "papercusp",
    });
  });

  it("resumeAccountPlan: --account is honored in ANY mode (no prompt)", () => {
    // The pin is spawn-env only and dropped on resume; an explicit flag re-applies
    // it directly — both interactive and scripting (--no-picker) modes.
    expect(resumeAccountPlan({ account: "aviynw6", picker: true })).toEqual({
      source: "flag",
      account: "aviynw6",
      prompt: false,
    });
    expect(resumeAccountPlan({ account: "aviynw6", picker: false })).toEqual({
      source: "flag",
      account: "aviynw6",
      prompt: false,
    });
  });

  it("resumeAccountPlan: interactive resume PROMPTS; scripting (--no-picker) does NOT (option 1)", () => {
    expect(resumeAccountPlan({ account: null, picker: true })).toEqual({
      source: "prompt",
      account: null,
      prompt: true,
    });
    // --no-picker: no surprise prompt in scripts → default credential (byte-identical resume).
    expect(resumeAccountPlan({ account: null, picker: false })).toEqual({
      source: "none",
      account: null,
      prompt: false,
    });
  });

  it("chooseResumeAccount: explicit Claude --account=default stamps the force-system-login envelope and tracked-fork marker without consulting the gateway", async () => {
    const account = await chooseResumeAccount(
      {
        agent: "claude",
        workspaceId: "ws1",
        coordOwnerId: "su-resume-default",
      },
      { account: "default", picker: false },
    );
    expect(account).toEqual({
      mode: "default",
      id: null,
      forward: "system",
      env: defaultAccountEnv(),
      notice: "using the default system account (inference gateway skipped).",
    });
    // A tracked fork re-resolves its account through bootstrap-su. The launcher must
    // carry the explicit system choice across that boundary; omitting it means the
    // server interprets the request as the owner's nominated gateway default.
    expect(
      forkBootstrapBody({ agent: "claude", cwd: "/repo" }, account.forward ?? account.id),
    ).toMatchObject({ account: "system" });
  });

  it("chooseResumeAccount: a scripted resume with no account flag also uses the system-login envelope", async () => {
    await expect(
      chooseResumeAccount(
        {
          agent: "claude",
          workspaceId: "ws1",
          coordOwnerId: "su-resume-default",
        },
        { account: null, picker: false },
      ),
    ).resolves.toEqual({
      mode: "default",
      id: null,
      forward: "system",
      env: defaultAccountEnv(),
      notice: null,
    });
  });

  it("chooseResumeAccount: no-picker Codex resume inherits saved --account=auto when new args omit it", async () => {
    const account = await withAccountChoices(
      {
        gatewayOn: true,
        pool: ["codex-main"],
        forcedAccounts: [],
        excludeAccounts: [],
        provider: "codex",
      },
      () =>
        chooseResumeAccount(
          {
            agent: "codex",
            workspaceId: "ws1",
            coordOwnerId: "su-resume-codex-auto",
            launchArgv: ["psu", "--no-picker", "--account=auto"],
          },
          { account: null, picker: false, model: "gpt-6.1-sol:xhigh" },
        ),
    );

    expect(account).toMatchObject({
      mode: "auto",
      auto: true,
      forward: "auto",
      provider: "codex",
      env: {},
    });
  });

  const withAccountChoices = async (
    accounts: Record<string, unknown>,
    run: () => Promise<unknown>,
  ) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ accounts }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      return await run();
    } finally {
      fetchSpy.mockRestore();
    }
  };

  it("chooseResumeAccount: explicit auto fails closed when the gateway route is unavailable", async () => {
    await expect(
      withAccountChoices(
        {
          gatewayOn: false,
          pool: [],
          forcedAccounts: [],
          excludeAccounts: [],
          provider: "claude",
        },
        () =>
          chooseResumeAccount(
            {
              agent: "claude",
              workspaceId: "ws1",
              coordOwnerId: "su-resume-auto",
            },
            { account: "auto", picker: false },
          ),
      ),
    ).rejects.toThrow(/refusing to fall back to the default system login/i);
  });

  it("chooseResumeAccount: an invalid named pin fails closed instead of returning the default marker", async () => {
    await expect(
      withAccountChoices(
        {
          gatewayOn: true,
          pool: ["allowed"],
          forcedAccounts: [],
          excludeAccounts: [],
          provider: "claude",
        },
        () =>
          chooseResumeAccount(
            {
              agent: "claude",
              workspaceId: "ws1",
              coordOwnerId: "su-resume-pin",
            },
            { account: "not-allowed", picker: false },
          ),
      ),
    ).rejects.toThrow(/not an allowed pool account.*refusing to fall back/i);
  });

  it("chooseResumeAccount: OMP Claude auto remains an explicit config-carried gateway route", async () => {
    await expect(
      withAccountChoices(
        {
          gatewayOn: true,
          pool: ["allowed"],
          forcedAccounts: [],
          excludeAccounts: [],
          provider: "claude",
        },
        () =>
          chooseResumeAccount(
            { agent: "omp", workspaceId: "ws1", coordOwnerId: "su-resume-omp" },
            {
              account: "auto",
              picker: false,
              model: "claude-bridge/claude-opus-4-8:high",
            },
          ),
      ),
    ).resolves.toMatchObject({
      mode: "auto",
      auto: true,
      forward: "auto",
      provider: "claude",
      env: {},
    });
  });

  it("chooseResumeAccount: OMP OpenAI auto resolves against the Codex account pool", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          accounts: {
            gatewayOn: true,
            pool: ["codex-main"],
            forcedAccounts: [],
            excludeAccounts: [],
            provider: "codex",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      await expect(
        chooseResumeAccount(
          {
            agent: "omp",
            workspaceId: "ws1",
            coordOwnerId: "su-resume-omp-openai",
          },
          {
            account: "auto",
            picker: false,
            model: "openai-codex/gpt-5.6-terra:xhigh",
          },
        ),
      ).resolves.toMatchObject({
        mode: "auto",
        auto: true,
        forward: "auto",
        provider: "codex",
        env: {},
      });
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("agent=codex");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("chooseResumeAccount: OMP explicit gateway routes fail closed on incompatible or mismatched providers", async () => {
    await expect(
      chooseResumeAccount(
        {
          agent: "omp",
          workspaceId: "ws1",
          coordOwnerId: "su-resume-omp-foreign",
        },
        {
          account: "auto",
          picker: false,
          model: "google-vertex/claude-opus-4-8",
        },
      ),
    ).rejects.toThrow(/not compatible.*refusing model substitution/i);

    await expect(
      withAccountChoices(
        {
          gatewayOn: true,
          pool: ["claude-main"],
          forcedAccounts: [],
          excludeAccounts: [],
          provider: "claude",
        },
        () =>
          chooseResumeAccount(
            {
              agent: "omp",
              workspaceId: "ws1",
              coordOwnerId: "su-resume-omp-mismatch",
            },
            {
              account: "claude-main",
              picker: false,
              model: "openai-codex/gpt-5.6-terra",
            },
          ),
      ),
    ).rejects.toThrow(/claude account.*requires codex accounts.*refusing/i);
  });

  it("chooseResumeAccount: valid Claude auto remains gateway-only and never carries the default marker", async () => {
    const resolved = await withAccountChoices(
      {
        gatewayOn: true,
        pool: ["allowed"],
        forcedAccounts: [],
        excludeAccounts: [],
        provider: "claude",
      },
      () =>
        chooseResumeAccount(
          {
            agent: "claude",
            workspaceId: "ws1",
            coordOwnerId: "su-resume-auto",
          },
          { account: "auto", picker: false },
        ),
    );
    expect(resolved).toMatchObject({
      auto: true,
      forward: "auto",
      env: {
        ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
        ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
      },
    });
    expect(
      (resolved as { env: Record<string, string> }).env[
        ACCOUNT_ROUTING_MODE_ENV
      ],
    ).toBe("auto");
  });

  // WI-10002057: terminalRenderEnv(agent, env = process.env) DEFERS to an explicit
  // CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN (it exists to stamp that value, not to
  // override an operator's), and buildResumeEnv / trackedForkEnvelopeEnv call it
  // WITHOUT injecting an env. So any assertion that hardcodes the key silently
  // measures the RUNNER's environment instead of the contract — and every
  // psu-launched Claude session exports that variable, which made these three
  // tests red for every agent running the suite from inside psu while staying
  // green in the gate's clean env. Measured A/B (only this variable differs):
  // unset => 13 passed | 0 failed; set => 3 failed. Pin it for these tests, and
  // restore EXACTLY rather than calling vi.unstubAllEnvs(), which would also drop
  // env stubs owned by other tests in this file.
  let priorAlternateScreen: string | undefined;
  const pinAlternateScreenUnset = () => {
    priorAlternateScreen = process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
    delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
  };
  afterEach(() => {
    if (priorAlternateScreen === undefined) return;
    process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = priorAlternateScreen;
    priorAlternateScreen = undefined;
  });

  it("buildResumeEnv: resumed psu sessions always carry the agent-session marker", () => {
    pinAlternateScreenUnset();
    const session = {
      agent: "claude",
      id: 7,
      coordOwnerId: "su-abc",
      workspaceId: "ws1",
    };
    expect(buildResumeEnv(session)).toEqual({
      ...resumeEnvFor(session),
      PAPERCUSP_AGENT_SESSION: "1",
      // Console-history preservation: a resumed Claude CLI stays off the alternate screen.
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ...contextTrimmingEnv("claude"),
    });
  });

  it("buildResumeEnv: the context-trimming trio is re-stamped on a resume (WI-2140943 lane 2)", () => {
    // A resume spawns a NEW CLI — without ENABLE_TOOL_SEARCH / PAPERCUSP_TOOLS /
    // PAPERCUSP_CONTEXT_TIER a gateway-routed claude boots with the whole catalog
    // inline (measured 756k first-turn tokens vs ~143k). Same rationale as P-022.
    const claude = {
      agent: "claude",
      id: 7,
      coordOwnerId: "su-abc",
      workspaceId: "ws1",
    };
    const env = buildResumeEnv(claude) as Record<string, string>;
    expect(env).toMatchObject(contextTrimmingEnv("claude"));
    // P-007: derived, not unconditional — resumeArgsFor ALSO denies ToolSearch, so on a resume
    // this key would enable nothing and merely inject a DeferredToolPlaceholder every request.
    expect(env.ENABLE_TOOL_SEARCH).toBe(
      nativeDeferralReachable() ? "true" : undefined,
    );
    expect(env.PAPERCUSP_CONTEXT_TIER).toBe("trimmed");
    expect(env.PAPERCUSP_TOOLS).toContain("coord:orient");
    // Non-claude agents get only the payload tier (no CC-specific keys).
    const omp = buildResumeEnv({
      agent: "omp",
      id: 8,
      coordOwnerId: "su-def",
      workspaceId: "ws1",
    }) as Record<string, string>;
    expect(omp.PAPERCUSP_CONTEXT_TIER).toBe("trimmed");
    expect(omp.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(omp.PAPERCUSP_TOOLS).toBeUndefined();
  });

  it("re-seeds deferred Papercusp tool references before a Claude transcript resumes", () => {
    const root = mkdtempSync(join(tmpdir(), "psu-resume-tool-reference-"));
    try {
      const configDir = join(root, "claude");
      const projectDir = join(configDir, "projects", "-repo");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "native-1.jsonl"), [
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_reference", tool_name: "mcp__papercusp-su__plans_audit" }] },
        }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_reference", tool_name: "mcp__filesystem__read_file" }] },
        }),
      ].join("\n"));
      const env = { PAPERCUSP_TOOLS: "tools:find,coord:orient" };

      const result = addClaudeResumeToolReferencesToEnv(
        { agent: "claude", sessionId: "native-1", configDir },
        env,
        { home: root },
      );

      expect(result).toMatchObject({ restored: 1, toolReferences: ["mcp__papercusp-su__plans_audit"] });
      expect(env.PAPERCUSP_TOOLS).toBe("tools:find,coord:orient,mcp__papercusp-su__plans_audit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops NATIVE deferred tool references from a resumed transcript but never from a fork's source (EI-24890753013901545)", () => {
    const root = mkdtempSync(join(tmpdir(), "psu-resume-native-reference-"));
    try {
      const configDir = join(root, "claude");
      const projectDir = join(configDir, "projects", "-repo");
      mkdirSync(projectDir, { recursive: true });
      const line = (name: string) =>
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_reference", tool_name: name }] } });
      const transcript = [line("ExitPlanMode"), line("mcp__papercusp-su__plans_audit")].join("\n");
      const file = join(projectDir, "native-2.jsonl");
      const session = { agent: "claude", sessionId: "native-2", configDir };

      // FORK: its transcriptPath is the SOURCE session's — it must stay byte-identical.
      const forkEnv = { PAPERCUSP_TOOLS: "tools:find" };
      writeFileSync(file, transcript);
      const forked = addClaudeResumeToolReferencesToEnv(session, forkEnv, { home: root });
      expect(readFileSync(file, "utf8")).toBe(transcript);
      expect(forked.nativeNeutralized ?? { rewritten: 0 }).toMatchObject({ rewritten: 0 });

      // RESUME: native reference dropped, Papercusp one kept and still re-seeded.
      const env = { PAPERCUSP_TOOLS: "tools:find" };
      const resumed = addClaudeResumeToolReferencesToEnv(session, env, { home: root, neutralizeNative: true });
      expect(resumed.nativeNeutralized).toMatchObject({ rewritten: 1, toolNames: ["ExitPlanMode"] });
      const after = readFileSync(file, "utf8");
      // The reference BLOCK is gone (it becomes a text marker that still names the tool).
      expect(after).not.toContain('"tool_name":"ExitPlanMode"');
      expect(after).toContain('"tool_name":"mcp__papercusp-su__plans_audit"');
      expect(env.PAPERCUSP_TOOLS).toBe("tools:find,mcp__papercusp-su__plans_audit");

      // No PAPERCUSP_TOOLS seed at all: the native drop must still happen on a resume.
      writeFileSync(file, transcript);
      const noSeed = addClaudeResumeToolReferencesToEnv(session, {}, { home: root, neutralizeNative: true });
      expect(noSeed.nativeNeutralized).toMatchObject({ rewritten: 1 });
      expect(readFileSync(file, "utf8")).not.toContain('"tool_name":"ExitPlanMode"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every CLI-spawn env builder stamps the context-trimming trio (WI-2140943 lane 2)", () => {
    // roleFlow was the last uncovered spawn path: it stamped nativeCompactionEnv but NOT
    // contextTrimmingEnv, and runWrapper's healContextTrimmingEnv only fires on the
    // hostHandoff branch — so a role session (how a system routine launches an agent,
    // `--launched-by=system:…`) booted with the whole catalog inline. Measured on the live
    // consult-expiry-sweep session su-a961ddec: 753,066 first-turn tokens vs 94–150k
    // fleet-wide. nativeCompactionEnv is the sibling marker — it is applied at exactly the
    // same set of spawn sites, so requiring the pair keeps a NEW spawn path from shipping
    // with only half the stamp.
    const source = readFileSync(
      join(__dirname, "..", "scripts", "psu-launcher.mjs"),
      "utf8",
    );
    const compactionSites = [
      ...source.matchAll(/\.\.\.nativeCompactionEnv\(/g),
    ].length;
    const trimmingSites = [
      ...source.matchAll(/\.\.\.contextTrimmingEnv\(/g),
    ].length;
    expect(compactionSites).toBeGreaterThan(0);
    expect(trimmingSites).toBe(compactionSites);

    // ...and specifically on roleFlow, whose body must carry both stamps.
    const roleBody = source.slice(
      source.indexOf("async function roleFlow("),
      source.indexOf("async function launchFreshSu("),
    );
    expect(roleBody).toContain("...contextTrimmingEnv(res.agent)");
    expect(roleBody).toContain("...nativeCompactionEnv(res.agent)");
  });

  it("roleFlow launches the server-selected operation model", () => {
    const selected = requestedRoleModelFromBootstrap({ agent: "claude", model: "opus:xhigh" }, "sonnet:high");
    const launch = roleLaunchArgs("claude", { promptFile: "/p.md", model: selected });
    expect(launch.args).toContain("opus");
    expect(launch.args).not.toContain("sonnet");
    expect(requestedRoleModelFromBootstrap({ agent: "omp", model: "anthropic/claude-opus-4-8",
      envelopeEnv: { PAPERCUSP_OMP_MODEL_SELECTOR: "claude-bridge/claude-opus-4-8" } }, "anthropic/claude-sonnet-4-6"))
      .toBe("claude-bridge/claude-opus-4-8");
  });

  it("fresh SU native argv uses the identity-selected server model over the picker default", () => {
    const selected = requestedRoleModelFromBootstrap(
      { agent: "codex", model: "gpt-5.6-terra:xhigh" }, "gpt-5.6-sol:xhigh",
    );
    const argv = suWrapperExtraArgs("codex", { model: selected });
    expect(argv).toContain("gpt-5.6-terra");
    expect(argv).not.toContain("gpt-5.6-sol");
    const source = readFileSync(new URL("../scripts/psu-launcher.mjs", import.meta.url), "utf8");
    const fresh = source.slice(source.indexOf("async function launchFreshSu("));
    expect(fresh).toContain("requestedRoleModelFromBootstrap(res, args.model)");
  });

  it("buildResumeEnv: P-022 native-compaction retirement is re-stamped on Claude resumes only", () => {
    // A resume spawns a NEW CLI process — without the stamp a resumed Claude
    // session silently regains native auto-compact + /compact (the fresh-launch
    // paths already carry it; this pins the resume path).
    const claude = {
      agent: "claude",
      id: 7,
      coordOwnerId: "su-abc",
      workspaceId: "ws1",
    };
    expect(buildResumeEnv(claude)).toMatchObject({
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
    });
    // OMP compaction is papercusp-owned via its relocated per-session config,
    // not CC envs — no stamp for non-claude agents.
    const omp = {
      agent: "omp",
      id: 8,
      coordOwnerId: "su-def",
      workspaceId: "ws1",
    };
    const env = buildResumeEnv(omp) as Record<string, string>;
    expect(env.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect(env.DISABLE_COMPACT).toBeUndefined();
  });

  it("buildResumeEnv: account env LAYERS onto the resume identity/scope and marker", () => {
    pinAlternateScreenUnset();
    const session = {
      agent: "claude",
      id: 7,
      coordOwnerId: "su-abc",
      workspaceId: "ws1",
    };
    // No account → identity/scope exactly match resumeEnvFor; psu still adds
    // the marker that arms hook-level guards for Claude too (WI-3071).
    expect(buildResumeEnv(session)).toEqual({
      ...resumeEnvFor(session),
      PAPERCUSP_AGENT_SESSION: "1",
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ...contextTrimmingEnv("claude"),
    });
    // A resolved account env folds on top (the gateway pin the resume would otherwise lose).
    expect(
      buildResumeEnv(session, {
        accountEnv: {
          env: {
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
            ANTHROPIC_CUSTOM_HEADERS: "anthropic-account-id: aviynw6",
            PAPERCUSP_ACCOUNT_ID: "aviynw6",
          },
          notice: "pinned",
        },
      }),
    ).toEqual({
      PAPERCUSP_AGENT: "claude",
      PAPERCUSP_SID: "su-abc",
      PAPERCUSP_WORKSPACE: "ws1",
      PAPERCUSP_ADV_SESSION_ID: "7",
      PAPERCUSP_AGENT_SESSION: "1",
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      ...contextTrimmingEnv("claude"),
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
      ANTHROPIC_CUSTOM_HEADERS: "anthropic-account-id: aviynw6",
      PAPERCUSP_ACCOUNT_ID: "aviynw6",
    });
  });

  it("buildResumeEnv: the brain path still carries the agent-session marker alongside the account env", () => {
    const session = {
      agent: "claude",
      id: 7,
      coordOwnerId: "su-abc",
      workspaceId: "ws1",
    };
    const env = buildResumeEnv(session, {
      brain: true,
      accountEnv: { env: { PAPERCUSP_ACCOUNT_ID: "avi" }, notice: null },
    });
    expect(env.PAPERCUSP_AGENT_SESSION).toBe("1");
    expect(env.PAPERCUSP_ACCOUNT_ID).toBe("avi");
  });

  it("trackedForkEnvelopeEnv: a TRACKED --fork ALWAYS carries the agent-session marker (WI-3071 regression)", () => {
    // bootstrap-su (server-side) never sets PAPERCUSP_AGENT_SESSION — launchTrackedFork
    // used to spread its envelopeEnv verbatim, so a forked su session ran UNMARKED and
    // invisible to the destructive shared-tree git guard (pretooluse-bash-resource-gate.sh
    // gates git stash/reset --hard/clean -f/checkout . on exactly this var) and the
    // native-scheduler lockout. `git stash` executed unblocked on the shared staging tree
    // from a forked session on 2026-07-05 as a direct result.
    pinAlternateScreenUnset();
    const bootstrapEnvelopeEnv = {
      CLAUDE_CONFIG_DIR: "/home/x/.papercusp/su-claude-homes/session-9",
      PAPERCUSP_SID: "su-forked",
      PAPERCUSP_WORKSPACE: "ws1",
    };
    expect(trackedForkEnvelopeEnv(bootstrapEnvelopeEnv)).toEqual({
      ...bootstrapEnvelopeEnv,
      PAPERCUSP_AGENT_SESSION: "1",
      // Console-history preservation: a forked Claude CLI stays off the alternate screen.
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
      // P-022: a fork is a new CLI process — the native-compaction retirement is
      // re-stamped here just like fresh launches and resumes.
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      // WI-2140943 lane 2: so is the context-trimming trio (ENABLE_TOOL_SEARCH /
      // PAPERCUSP_TOOLS / PAPERCUSP_CONTEXT_TIER) — the server envelope never carries it.
      ...contextTrimmingEnv("claude"),
    });
    // Never trust the server envelope's own claim — the marker is asserted
    // client-side even if bootstrap-su starts sending something under the key.
    expect(
      trackedForkEnvelopeEnv({
        ...bootstrapEnvelopeEnv,
        PAPERCUSP_AGENT_SESSION: "0",
      }),
    ).toMatchObject({
      PAPERCUSP_AGENT_SESSION: "1",
    });
  });

  it("GATEWAY_ACCOUNT_HEADER stays in LOCKSTEP with the server ACCOUNT_HEADER (gateway.ts)", () => {
    // The launcher builds the pin env client-side; the header it sets MUST match the one the gateway
    // routes on, or the pin silently no-ops (the 2026-06-19 "routes to the default account" bug).
    expect(GATEWAY_ACCOUNT_HEADER).toBe(ACCOUNT_HEADER);
  });

  it("GATEWAY_OWNER_HEADER stays in LOCKSTEP with the server OWNER_HEADER (gateway.ts, WI-4402)", () => {
    // Same reasoning as the account-header lockstep test above: if this drifts from the gateway's
    // OWNER_HEADER, a resumed session's identity header silently stops reaching accounts:pin's
    // ownerPinMap lookup — the exact WI-4402 bug (the header was simply never SENT at all).
    expect(GATEWAY_OWNER_HEADER).toBe(OWNER_HEADER);
  });

  it("GATEWAY_CLIENT_AUTH_TOKEN stays in LOCKSTEP with server gatewaySpawnEnv", () => {
    expect(GATEWAY_CLIENT_AUTH_TOKEN).toBe(SERVER_GATEWAY_CLIENT_AUTH_TOKEN);
  });

  it("gatewayPinEnv: mirrors the complete server gatewaySpawnEnv route", () => {
    const env = gatewayPinEnv("aviynw");
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_CLIENT_AUTH_TOKEN);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`${ACCOUNT_HEADER}: aviynw`);
    expect(env.PAPERCUSP_ACCOUNT_ID).toBe("aviynw");
  });

  it("gatewayPinEnv: WI-4402 — omitted ownerId is byte-identical to today (no identity header)", () => {
    // Backward-compat guard: every EXISTING caller (and this file's other tests) calls gatewayPinEnv
    // with no 3rd arg — the resume path must not silently start sending a header nobody asked for.
    const env = gatewayPinEnv("aviynw", "claude");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`${ACCOUNT_HEADER}: aviynw`);
  });

  it("gatewayPinEnv: WI-4402 — a provided ownerId ALSO carries the session-identity header, so accounts:pin can reach this resumed session", () => {
    const env = gatewayPinEnv("aviynw", "claude", "su-71ef850a-owner");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      `${ACCOUNT_HEADER}: aviynw\n${OWNER_HEADER}: su-71ef850a-owner`,
    );
  });

  it("gatewayPinEnv: codex pins are config-file based and only carry the account id in env (ownerId ignored — codex has no ANTHROPIC_CUSTOM_HEADERS path)", () => {
    expect(gatewayPinEnv("codex-main", "codex")).toEqual({
      PAPERCUSP_ACCOUNT_ID: "codex-main",
    });
    expect(gatewayPinEnv("codex-main", "codex", "su-owner")).toEqual({
      PAPERCUSP_ACCOUNT_ID: "codex-main",
    });
  });

  it("accountRoutingMode: the ONE --account value classifies into the 3 explicit routing modes", () => {
    // account-routing-3-options (owner, 2026-06-30): default / auto / pin — mirrors the server's
    // resolveAccountPin keyword handling (kept in lockstep). Case-insensitive + trimmed.
    for (const v of [
      undefined,
      null,
      "",
      "  ",
      "default",
      "DEFAULT",
      " none ",
      "system",
      "System",
    ])
      expect(accountRoutingMode(v)).toBe("default");
    for (const v of ["auto", "AUTO", " gateway ", "Gateway"])
      expect(accountRoutingMode(v)).toBe("auto");
    // Anything else is a specific pool account id → pin.
    for (const v of ["aviynw6", "codex-main", "team-pool-3"])
      expect(accountRoutingMode(v)).toBe("pin");
  });

  it("codexAutoPoolVerdict: REFUSES an all-walled Codex auto route, naming the denominator, the horizon and the re-route that works", () => {
    const now = Date.UTC(2026, 8, 5, 20, 0, 0);
    const verdict = codexAutoPoolVerdict({
      agent: "codex",
      model: "gpt-5.6-sol",
      account: "auto",
      stats: {
        codexHealthyAccounts: 0,
        codexTotalAccounts: 7,
        codexEarliestRecoveryAt: now + 3_600_000,
      },
      now,
    });
    expect(verdict.kind).toBe("refuse");
    expect(verdict.recoveryAt).toBe(now + 3_600_000);
    expect(verdict.message).toContain("REFUSING TO LAUNCH");
    expect(verdict.message).toContain("0 of 7 ChatGPT accounts serviceable");
    expect(verdict.message).toContain(
      "earliest known recovery 2026-09-05T21:00:00.000Z",
    );
    // The refusal must name the lever that ACTUALLY works. Auto-routing is
    // PROVIDER-SCOPED, so no --account value can cross to another provider's pool;
    // a refusal that sent the reader to --account would cost them the same wall again.
    expect(verdict.message).toContain("--agent claude");
    expect(verdict.message).toContain(ALLOW_WALLED_LAUNCH_ENV);

    // Fail open: a healthy pool, a non-Codex route, and a non-auto route all proceed.
    for (const input of [
      {
        agent: "codex",
        model: "gpt-5.6-sol",
        account: "auto",
        stats: {
          codexHealthyAccounts: 1,
          codexTotalAccounts: 7,
          codexEarliestRecoveryAt: 0,
        },
      },
      {
        agent: "claude",
        model: "claude-fable-5",
        account: "auto",
        stats: { codexHealthyAccounts: 0, codexTotalAccounts: 7 },
      },
      {
        agent: "codex",
        model: "gpt-5.6-sol",
        account: "default",
        stats: { codexHealthyAccounts: 0, codexTotalAccounts: 7 },
      },
    ])
      expect(codexAutoPoolVerdict({ ...input, now }).kind).toBe("proceed");
  });

  it("codexAutoPoolVerdict: distinguishes a live upstream outage from an account usage wall", () => {
    const now = Date.UTC(2026, 8, 5, 20, 0, 0);
    const verdict = codexAutoPoolVerdict({
      agent: "codex",
      model: "gpt-5.6-sol",
      account: "auto",
      stats: {
        codexHealthyAccounts: 0,
        codexTotalAccounts: 8,
        // This is an account park horizon and must not be presented as network recovery.
        codexEarliestRecoveryAt: now + 60_000,
        codexUnserviceableCause: "upstream-unreachable",
      },
      now,
    });
    expect(verdict.kind).toBe("refuse");
    expect(verdict.recoveryAt).toBeNull();
    expect(verdict.message).toContain("Codex upstream has not responded");
    expect(verdict.message).toContain("fresh transport failures across accounts");
    expect(verdict.message).toContain("transport cause has not been established");
    expect(verdict.message).toContain("do not establish a usage or credit wall");
    expect(verdict.message).not.toContain("Check this machine's network");
    expect(verdict.message).not.toContain("429");
    expect(verdict.message).not.toContain("earliest known recovery");
  });

  it('codexAutoPoolVerdict: launches through a known temporary cooldown, while preserving quota/unknown refusals', async () => {
    const now = Date.UTC(2026, 9, 14, 18, 16, 40);
    const stats = { codexHealthyAccounts: 0, codexTotalAccounts: 8,
      codexEarliestRecoveryAt: Date.UTC(2026, 9, 14, 18, 18, 44, 413),
      codexUnserviceableCause: 'temporary-cooldown' as const };
    const verdict = codexAutoPoolVerdict({ agent: 'codex', account: 'auto', stats, now });
    expect(verdict.kind).toBe('warn');
    expect(verdict.message).toContain('temporarily cooling down');
    expect(verdict.message).toContain('not a usage or credit wall');
    expect(verdict.message).not.toContain('REFUSING');
    expect(verdict.message).not.toContain('Every model call would fail');
    const log = vi.fn();
    await expect(preflightCodexAutoPool({ agent: 'codex', account: 'auto', log, env: {},
      fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ ...stats,
        codexEarliestRecoveryAt: Date.now() + 120_000 }) })) as unknown as typeof fetch })).resolves.toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('temporarily cooling down'));
    const blocked = codexAutoPoolVerdict({ agent: 'codex', account: 'auto', now,
      stats: { ...stats, codexUnserviceableCause: 'accounts-unserviceable' } });
    expect(blocked.kind).toBe('refuse');
    expect(blocked.message).toContain('credential quarantine');
    expect(blocked.message).not.toContain('fully walled');
    expect(blocked.message).not.toContain('Every model call would fail fast with 429');
    expect(codexAutoPoolVerdict({ agent: 'codex', account: 'auto', now,
      stats: { ...stats, codexUnserviceableCause: undefined } }).kind).toBe('refuse');
  });

  it.each([
    { kind: "timeout" as const, diagnosis: "upstream response timeout" },
    { kind: "dns" as const, diagnosis: "DNS lookup error" },
    { kind: "connect" as const, diagnosis: "connection error" },
    { kind: "other" as const, diagnosis: "transport cause has not been established" },
  ])("codexAutoPoolVerdict: reports measured $kind failures without inventing account exhaustion", ({ kind, diagnosis }) => {
    const verdict = codexAutoPoolVerdict({
      agent: "codex",
      model: "gpt-6.1-sol",
      account: "auto",
      stats: {
        codexHealthyAccounts: 0,
        codexTotalAccounts: 8,
        codexEarliestRecoveryAt: null,
        codexUnserviceableCause: "upstream-unreachable",
        codexReachability: { lastTransportFailureKind: kind },
      },
    });
    expect(verdict.kind).toBe("refuse");
    expect(verdict.recoveryAt).toBeNull();
    expect(verdict.message).toContain(diagnosis);
    expect(verdict.message).toContain("do not establish a usage or credit wall");
    expect(verdict.message).not.toContain("fully walled");
    expect(verdict.message).not.toContain("Check this machine's network");
    if (kind === "timeout") expect(verdict.message).toContain("does not establish that this machine's network is down");
  });

  it("codexAutoPoolVerdict: an UNKNOWN horizon still refuses; a horizon already PAST only warns", () => {
    const now = Date.UTC(2026, 8, 5, 20, 0, 0);
    // OMP routed through the Codex pool, walled with no known recovery: still futile.
    const unknownHorizon = codexAutoPoolVerdict({
      agent: "omp",
      model: "openai-codex/gpt-5.6-terra:xhigh",
      account: { mode: "auto", provider: "codex" },
      stats: {
        codexHealthyAccounts: 0,
        codexTotalAccounts: 2,
        codexEarliestRecoveryAt: null,
      },
      now,
    });
    expect(unknownHorizon.kind).toBe("refuse");
    expect(unknownHorizon.recoveryAt).toBeNull();
    expect(unknownHorizon.message).toContain(
      "0 of 2 ChatGPT accounts serviceable",
    );
    expect(unknownHorizon.message).toContain("earliest recovery unknown");

    // A snapshot that contradicts ITSELF — walled, yet its own predicted recovery has
    // already passed — may simply be stale. That reading stays ADVISORY: the whole
    // fail-open design turns on never stranding a launch on an uncertain measurement.
    const stale = codexAutoPoolVerdict({
      agent: "codex",
      model: "gpt-5.6-sol",
      account: "auto",
      stats: {
        codexHealthyAccounts: 0,
        codexTotalAccounts: 7,
        codexEarliestRecoveryAt: now - 1,
      },
      now,
    });
    expect(stale.kind).toBe("warn");
    expect(stale.message).toContain("may be stale");
    expect(stale.message).not.toContain("REFUSING");
  });

  it("preflightCodexAutoPool: a valid scoped route never reads the unrelated ambient pool", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({
      codexHealthyAccounts: 0, codexTotalAccounts: 8, codexEarliestRecoveryAt: Date.now() + 60_000,
    }) })) as unknown as typeof fetch;
    await expect(preflightCodexAutoPool({ agent: "codex", account: "auto", fetchImpl,
      env: { PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: "http://127.0.0.1:32101", token: "a".repeat(64) }) },
    })).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['{"token":"secret-value', JSON.stringify({ baseURL: "https://example.com", token: "a".repeat(64) }),
    JSON.stringify({ baseURL: "http://127.0.0.1:32101", token: "short" })])(
    "preflightCodexAutoPool: invalid scoped binding refuses before ambient fallback", async encoded => {
      const fetchImpl = vi.fn();
      await expect(preflightCodexAutoPool({ agent: "codex", account: "auto", fetchImpl,
        env: { PAPERCUSP_SCOPED_INFERENCE_GATEWAY: encoded },
      })).rejects.toThrow("Invalid scoped inference gateway envelope");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  it("preflightCodexAutoPool: ABORTS a provably-walled launch, and fails open for healthy, legacy, unreachable, and timed-out responses", async () => {
    const allWalledFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        codexHealthyAccounts: 0,
        codexTotalAccounts: 7,
        codexEarliestRecoveryAt: Date.now() + 60_000,
      }),
    })) as unknown as typeof fetch;
    const log = vi.fn();
    await expect(
      preflightCodexAutoPool({
        agent: "codex",
        model: "gpt-5.6-sol",
        account: "auto",
        fetchImpl: allWalledFetch,
        log,
        port: 9876,
        timeoutMs: 25,
        env: {},
      }),
    ).resolves.toBe(false);
    expect(allWalledFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/stats",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("REFUSING TO LAUNCH");

    const networkLog = vi.fn();
    await expect(
      preflightCodexAutoPool({
        agent: "codex",
        model: "gpt-5.6-sol",
        account: "auto",
        fetchImpl: vi.fn(async () => ({
          ok: true,
          json: async () => ({
            codexHealthyAccounts: 0,
            codexTotalAccounts: 8,
            codexEarliestRecoveryAt: Date.now() + 60_000,
            codexUnserviceableCause: "upstream-unreachable",
          }),
        })) as unknown as typeof fetch,
        log: networkLog,
        env: {},
      }),
    ).resolves.toBe(false);
    expect(String(networkLog.mock.calls[0]?.[0])).toContain(
      "The underlying transport cause has not been established",
    );
    expect(String(networkLog.mock.calls[0]?.[0])).not.toContain("429");

    // EVERY uncertain reading proceeds silently. A down, legacy or half-described
    // gateway must never block psu — only an affirmative, complete, self-consistent
    // all-walled snapshot does.
    for (const stats of [
      { codexHealthyAccounts: 1, codexTotalAccounts: 7 },
      { codexTotalAccounts: 7 },
      { codexHealthyAccounts: 0 },
      {
        codexHealthyAccounts: null,
        codexTotalAccounts: 7,
        codexEarliestRecoveryAt: null,
      },
    ]) {
      const quietLog = vi.fn();
      await expect(
        preflightCodexAutoPool({
          agent: "codex",
          model: "gpt-5.6-sol",
          account: "auto",
          fetchImpl: vi.fn(async () => ({
            ok: true,
            json: async () => stats,
          })) as unknown as typeof fetch,
          log: quietLog,
          env: {},
        }),
      ).resolves.toBe(true);
      expect(quietLog).not.toHaveBeenCalled();
    }

    await expect(
      preflightCodexAutoPool({
        agent: "codex",
        model: "gpt-5.6-sol",
        account: "auto",
        env: {},
        fetchImpl: vi.fn(async () => {
          throw new Error("gateway unavailable");
        }) as unknown as typeof fetch,
      }),
    ).resolves.toBe(true);

    vi.useFakeTimers();
    try {
      const timedOut = preflightCodexAutoPool({
        agent: "codex",
        model: "gpt-5.6-sol",
        account: "auto",
        timeoutMs: 5,
        env: {},
        fetchImpl: vi.fn((_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })) as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(6);
      await expect(timedOut).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preflightCodexAutoPool: the env override downgrades a refusal to a loud warning instead of an abort", async () => {
    const log = vi.fn();
    await expect(
      preflightCodexAutoPool({
        agent: "codex",
        model: "gpt-5.6-sol",
        account: "auto",
        log,
        env: { [ALLOW_WALLED_LAUNCH_ENV]: "1" },
        fetchImpl: vi.fn(async () => ({
          ok: true,
          json: async () => ({
            codexHealthyAccounts: 0,
            codexTotalAccounts: 7,
            codexEarliestRecoveryAt: Date.now() + 60_000,
          }),
        })) as unknown as typeof fetch,
      }),
    ).resolves.toBe(true);
    const printed = String(log.mock.calls[0]?.[0]);
    expect(printed).toContain("REFUSING TO LAUNCH");
    expect(printed).toContain("launching anyway");
  });

  it("preflightCodexAutoPool: skips the network for routes outside the Codex auto pool", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      preflightCodexAutoPool({
        agent: "claude",
        model: "claude-fable-5",
        account: "auto",
        fetchImpl,
        env: {},
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("wires the Codex auto-pool preflight into fresh SU, role, same-backend resume, and cross-backend port launches", () => {
    const source = readFileSync(
      join(__dirname, "..", "scripts", "psu-launcher.mjs"),
      "utf8",
    );
    const section = (start, end) => {
      const from = source.indexOf(start);
      const to = end ? source.indexOf(end, from + start.length) : source.length;
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      return source.slice(from, to);
    };

    const role = section("async function roleFlow(", "async function setClaudeTokenFlow(");
    expect(role.indexOf("await preflightCodexAutoPool(")).toBeGreaterThan(-1);
    expect(role.indexOf("/api/agent-mcp/console/bootstrap-role")).toBeGreaterThan(
      role.indexOf("await preflightCodexAutoPool("),
    );

    const resume = section("async function launchResolvedResume(", "async function resumeFlow(");
    expect(resume).toContain('target.operation === "port"');
    expect(resume).toContain("await launchSessionPort(");
    expect(resume).toContain("await preflightCodexAutoPool(");

    const port = section("async function launchSessionPort(", "async function launchResolvedResume(");
    expect(port).toContain("await launchFreshSuImpl(");
    const fresh = section("async function launchFreshSu(", null);
    expect(fresh).toContain("preflightCodexAutoPoolImpl = preflightCodexAutoPool");
    expect(fresh).toContain("await preflightCodexAutoPoolImpl(");

    const originalResume = section("async function resumeFlow(", null);
    const guardedOriginal = originalResume.slice(0, originalResume.indexOf('const data = await apiImpl("/api/adv/sessions/resumable")'));
    expect(guardedOriginal).toContain("await preflightCodexAutoPool(");
    expect(guardedOriginal.indexOf("await launchResume(")).toBeGreaterThan(guardedOriginal.indexOf("await preflightCodexAutoPool("));
    expect(guardedOriginal).not.toContain("tryRematerializeFromArchive");
    expect(source.match(/await preflightCodexAutoPool(?:Impl)?\(/g) ?? []).toHaveLength(4);

    // Every call site must ACT on the verdict. A preflight that computes futility and
    // launches regardless IS the bug this guard exists for: measured 2026-09-11, the
    // warn-only ancestor printed "0 of 7 serviceable" into 342 judge launches over 3h
    // that emitted zero cards (EI-22976924584016603). Negating the call is what turns
    // the measurement into an abort, so assert the negation, not merely the call.
    expect(source.match(/!\(await preflightCodexAutoPool(?:Impl)?\(/g) ?? []).toHaveLength(
      4,
    );
    // …and each abort carries the distinguishable exit code (const + 4 call sites).
    expect(
      (source.match(/WALLED_POOL_REFUSAL_EXIT/g) ?? []).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("gatewayAutoEnv: claude routes through the gateway with NO account pin header (let it auto-select)", () => {
    const env = gatewayAutoEnv("claude");
    // Base URL points at the localhost gateway; crucially NO account header + NO PAPERCUSP_ACCOUNT_ID,
    // so the gateway active()/drain-selects an available account and fails over (vs gatewayPinEnv).
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_CLIENT_AUTH_TOKEN);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
  });

  it("gatewayAutoEnv: non-claude providers get {} (auto-routing wired for claude only — matches resolveAccountPin)", () => {
    expect(gatewayAutoEnv("codex")).toEqual({});
    expect(gatewayAutoEnv("omp")).toEqual({});
  });

  it("gatewayAutoEnv: WI-4402 — omitted ownerId is byte-identical to today (no identity header)", () => {
    expect(gatewayAutoEnv("claude").ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("gatewayAutoEnv: WI-4402 — a provided ownerId carries ONLY the session-identity header (still no account pin — the point of auto)", () => {
    const env = gatewayAutoEnv("claude", "su-71ef850a-owner");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      `${OWNER_HEADER}: su-71ef850a-owner`,
    );
    expect(env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
  });

  it("gatewayAutoEnv: WI-4402 — ownerId is ignored for non-claude providers ({} either way)", () => {
    expect(gatewayAutoEnv("codex", "su-owner")).toEqual({});
  });

  it("sanitizeInheritedEnv: default is gateway-free while explicit auto/pin overlays restore the complete route (WI-5052)", () => {
    const contaminatedParent = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
      ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
      ANTHROPIC_CUSTOM_HEADERS: `${ACCOUNT_HEADER}: inherited-account`,
      PAPERCUSP_ANTHROPIC_URL: "http://127.0.0.1:8788",
      PAPERCUSP_ACCOUNT_ID: "inherited-account",
      PAPERCUSP_CODEX_GATEWAY: "1",
      [ACCOUNT_ROUTING_MODE_ENV]: "default",
      CLAUDE_CODE_OAUTH_TOKEN: "direct-system-oauth",
      KEEP_ME: "yes",
    };
    const clean = sanitizeInheritedEnv(contaminatedParent);
    expect(clean).toEqual({ KEEP_ME: "yes" });

    const defaultEnv = { ...clean };
    expect(defaultEnv).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(defaultEnv).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(defaultEnv).not.toHaveProperty("PAPERCUSP_ACCOUNT_ID");

    const autoEnv = { ...clean, ...gatewayAutoEnv("claude", "su-auto") };
    expect(autoEnv.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(autoEnv.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_CLIENT_AUTH_TOKEN);
    expect(autoEnv.ANTHROPIC_CUSTOM_HEADERS).toBe(`${OWNER_HEADER}: su-auto`);
    expect(autoEnv).not.toHaveProperty("PAPERCUSP_ACCOUNT_ID");

    const pinEnv = {
      ...clean,
      ...gatewayPinEnv("acct-pin", "claude", "su-pin"),
    };
    expect(pinEnv.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(pinEnv.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_CLIENT_AUTH_TOKEN);
    expect(pinEnv.ANTHROPIC_CUSTOM_HEADERS).toBe(
      `${ACCOUNT_HEADER}: acct-pin\n${OWNER_HEADER}: su-pin`,
    );
    expect(pinEnv.PAPERCUSP_ACCOUNT_ID).toBe("acct-pin");
  });

  it("sanitizeInheritedEnv strips direct/provider credentials so only the explicit route overlay can re-add auth", () => {
    expect(
      sanitizeInheritedEnv({
        ANTHROPIC_AUTH_TOKEN: "user-direct-token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.invalid",
      }),
    ).toEqual({});
  });

  it("sanitizeInheritedEnv strips the spawner claude session-identity markers (child-session transcript suppression, WI-5002)", () => {
    // CLAUDE_CODE_CHILD_SESSION=1 inherited from a spawning claude session makes
    // the launched psu claude treat itself as a child session and silently skip
    // transcript persistence (live-bisected 2026-07-17). The whole ancestry
    // family must be re-derived by the child, never inherited.
    expect(
      sanitizeInheritedEnv({
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "aaaa-bbbb",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_BRIDGE_SESSION_ID: "cccc",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_EXECPATH: "/versions/2.1.211",
        CLAUDE_CONFIG_DIR: "/home/u/.papercusp/session-claude/su-spawner",
        KEEP_ME: "v",
      }),
    ).toEqual({ KEEP_ME: "v" });
  });

  it("applyCodexDiagnosticEnv stamps the deterministic core/TUI filter and replaces inherited RUST_LOG", () => {
    const env = { RUST_LOG: "debug", KEEP_ME: "v" };
    expect(applyCodexDiagnosticEnv(env, "codex")).toEqual({
      RUST_LOG: CODEX_DIAGNOSTIC_RUST_LOG,
      KEEP_ME: "v",
    });
  });

  it("applyCodexDiagnosticEnv leaves non-Codex launches unchanged", () => {
    const env = { RUST_LOG: "debug", KEEP_ME: "v" };
    expect(applyCodexDiagnosticEnv(env, "claude")).toEqual(env);
  });

  it("headless Codex overrides an inherited browser command so OAuth cannot escape to the desktop", () => {
    expect(applyHeadlessCodexBrowserPolicy({
      PAPERCUSP_AGENT: "codex",
      PAPERCUSP_PSU_HEADLESS: "1",
      BROWSER: "google-chrome",
      KEEP_ME: "v",
    })).toEqual({
      PAPERCUSP_AGENT: "codex",
      PAPERCUSP_PSU_HEADLESS: "1",
      BROWSER: "false",
      KEEP_ME: "v",
    });
  });

  it("browser policy leaves visible Codex and non-Codex launches unchanged", () => {
    const visible = { PAPERCUSP_AGENT: "codex", BROWSER: "google-chrome" };
    const headlessClaude = {
      PAPERCUSP_AGENT: "claude",
      PAPERCUSP_PSU_HEADLESS: "1",
      BROWSER: "google-chrome",
    };
    expect(applyHeadlessCodexBrowserPolicy(visible)).toEqual(visible);
    expect(applyHeadlessCodexBrowserPolicy(headlessClaude)).toEqual(headlessClaude);
  });

  it("applies an exact private route after fresh and carry home materialization", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-scoped-route-"));
    const configPath = join(home, "config.toml");
    const gateway = { baseURL: "http://127.0.0.1:32101", token: "a".repeat(64) };
    const env = { PAPERCUSP_AGENT: "codex", CODEX_HOME: home, PAPERCUSP_SID: "su-private",
      PAPERCUSP_ACCOUNT_ROUTING_MODE: "pin", PAPERCUSP_ACCOUNT_ID: "provider-account",
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify(gateway) };
    try {
      for (const prior of ['model = "fixture-model"\n', codexGatewayConfigPatch('model = "fixture-model"\n', "ambient")]) {
        writeFileSync(configPath, prior);
        applyScopedNativeGateway(env);
        const config = readFileSync(configPath, "utf8");
        expect(config).toContain('base_url = "http://127.0.0.1:32101/v1"');
        expect(config).toContain(`experimental_bearer_token = "${gateway.token}"`);
        expect(config).toContain('"x-papercusp-account" = "provider-account"');
        expect(config).toContain('"x-papercusp-owner" = "su-private"');
        expect(config).toContain('model = "fixture-model"');
        expect(config).not.toContain('"ambient"');
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
      }
      expect(sanitizeInheritedEnv(env)).not.toHaveProperty("PAPERCUSP_SCOPED_INFERENCE_GATEWAY");
      expect(env.PAPERCUSP_SCOPED_INFERENCE_GATEWAY).toBe(JSON.stringify(gateway));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("refuses invalid private routes before writing the native home and keeps credentials out of errors", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-scoped-refusal-"));
    const path = join(home, "config.toml");
    const before = 'model = "fixture"\n';
    writeFileSync(path, before);
    const env = { PAPERCUSP_AGENT: "codex", CODEX_HOME: home,
      PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: "http://127.0.0.1:32101", token: "a".repeat(64) }) };
    try {
      for (const bad of [
        { ...env, PAPERCUSP_AGENT: "claude" },
        { ...env, CODEX_HOME: "relative" },
        { ...env, PAPERCUSP_ACCOUNT_ROUTING_MODE: "pin" },
        { ...env, PAPERCUSP_SCOPED_INFERENCE_GATEWAY: '{"token":"secret-value' },
      ]) {
        expect(() => applyScopedNativeGateway(bad)).toThrow(/scoped|Scoped/);
        expect(readFileSync(path, "utf8")).toBe(before);
      }
      try { applyScopedNativeGateway({ ...env, PAPERCUSP_SCOPED_INFERENCE_GATEWAY: '{"token":"secret-value' }); }
      catch (error) { expect(String(error)).not.toContain("secret-value"); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("codexGatewayConfigPatch inserts root provider selector before tables and replaces prior pin", () => {
    const current = [
      "# existing config",
      "project_doc_max_bytes = 0",
      "",
      "[features]",
      "memory_tool = false",
      "",
      "# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER",
      "[model_providers.papercusp-codex-gateway]",
      'http_headers = { "x-papercusp-account" = "old" }',
      "# END PAPERCUSP_CODEX_GATEWAY_PROVIDER",
      "",
    ].join("\n");
    const next = codexGatewayConfigPatch(current, "codex-main");
    expect(
      next.indexOf('model_provider = "papercusp-codex-gateway"'),
    ).toBeLessThan(next.indexOf("[features]"));
    expect(next).toContain('base_url = "http://127.0.0.1:8788/v1"');
    expect(next).toContain(
      'http_headers = { "originator" = "codex_cli_rs", "x-papercusp-account" = "codex-main" }',
    );
    expect(next).not.toContain('"old"');

    const auto = codexGatewayConfigPatch(next, null, {
      gatewayOn: true,
      ownerId: "su-codex",
      priority: "su",
    });
    expect(auto).toContain('model_provider = "papercusp-codex-gateway"');
    expect(auto).toContain('model_catalog_url = "http://127.0.0.1:8788/v1/models"');
    expect(auto).toContain('"originator" = "codex_cli_rs"');
    expect(auto).toContain('"x-papercusp-owner" = "su-codex"');
    expect(auto).toContain('"x-papercusp-priority" = "su"');
    expect(auto).not.toContain("x-papercusp-account");

    const direct = codexGatewayConfigPatch(auto);
    expect(direct).toContain("# existing config");
    expect(direct).not.toContain("PAPERCUSP_CODEX_GATEWAY");
    expect(direct).not.toContain("papercusp-codex-gateway");
  });

  it("codexGatewayConfigPatch replaces an explicit root provider and preserves profile selectors", () => {
    const current = 'model_provider = "openai"\n[profiles.direct]\nmodel_provider = "openai"\n';
    const auto = codexGatewayConfigPatch(current, null, { gatewayOn: true });
    const root = auto.split('[profiles.direct]', 1)[0];
    expect(root.match(/^model_provider\s*=/gm)).toHaveLength(1);
    expect(root).toContain('model_provider = "papercusp-codex-gateway"');
    expect(auto).toContain('[profiles.direct]\nmodel_provider = "openai"');
    expect(codexGatewayConfigPatch(auto, null, { gatewayOn: true })).toBe(auto);
    expect(codexGatewayConfigPatch(current)).toBe(current);
  });

  it("accountPinnable: gates on gatewayOn + pool membership + session-override (mirrors resolveAccountPin)", () => {
    const base = {
      gatewayOn: true,
      pool: ["aviynw", "aviynw2"],
      excludeAccounts: [],
      forcedAccounts: [],
    };
    expect(accountPinnable(base, "aviynw")).toBe(true);
    expect(accountPinnable({ ...base, gatewayOn: false }, "aviynw")).toBe(
      false,
    ); // gateway off → no pin
    expect(accountPinnable(base, "not-in-pool")).toBe(false);
    expect(
      accountPinnable({ ...base, excludeAccounts: ["aviynw"] }, "aviynw"),
    ).toBe(false);
    expect(
      accountPinnable({ ...base, forcedAccounts: ["aviynw2"] }, "aviynw"),
    ).toBe(false); // outside allow-list
    expect(
      accountPinnable({ ...base, forcedAccounts: ["aviynw"] }, "aviynw"),
    ).toBe(true);
    expect(accountPinnable(base, null)).toBe(false);
    expect(accountPinnable(null, "aviynw")).toBe(false);
  });

  it("accountPickerChoices offers gateway auto for both Claude and Codex pools", () => {
    for (const provider of ["claude", "codex"]) {
      const choices = accountPickerChoices({
        gatewayOn: true,
        pool: [`${provider}-main`],
        excludeAccounts: [],
        forcedAccounts: [],
        provider,
      });
      expect(choices.map((choice) => choice.value)).toEqual([
        "system",
        "auto",
        `${provider}-main`,
      ]);
    }
  });

  it("accountPickerChoices disables a measured used-up account and labels unknown usage", () => {
    const choices = accountPickerChoices({
      gatewayOn: true,
      provider: "codex",
      pool: ["used", "uncertain", "fresh"],
      accountStates: { used: "unavailable", uncertain: "unknown", fresh: "available" },
    });
    expect(choices.find((choice) => choice.value === "used")).toMatchObject({
      disabled: "(usage limit reached)",
    });
    expect(choices.find((choice) => choice.value === "used")?.name).toContain("used up");
    expect(choices.find((choice) => choice.value === "uncertain")?.name).toContain("unverified");
    expect(choices.find((choice) => choice.value === "uncertain")?.disabled).toBe(false);
    expect(choices.find((choice) => choice.value === "fresh")?.disabled).toBe(false);
  });

  it("accountPickerChoices blocks auto when a different-provider allow-list excludes the selected provider", () => {
    for (const provider of ["claude", "codex"]) {
      const other = provider === "claude" ? "codex" : "claude";
      const choices = accountPickerChoices({
        gatewayOn: true,
        provider,
        pool: [`${provider}-main`],
        forcedAccounts: [`${other}-main`],
      });
      expect(choices.find((choice) => choice.value === "auto")?.disabled)
        .toContain(`no allowed ${provider} accounts`);
      expect(choices.find((choice) => choice.value === `${provider}-main`)?.disabled)
        .toBe("(blocked by session-override)");
      expect(choices.some((choice) => choice.value === `${other}-main`)).toBe(false);
      expect(choices[0].value).toBe("system");
    }
  });

  it("accountPickerChoices applies exclusions to auto and re-enables it when an allowed account remains", () => {
    const base = {
      gatewayOn: true,
      provider: "claude",
      pool: ["claude-one", "claude-two"],
      forcedAccounts: ["claude-one", "claude-two"],
    };
    expect(accountPickerChoices({ ...base, excludeAccounts: base.pool })
      .find((choice) => choice.value === "auto")?.disabled)
      .toContain("no allowed claude accounts");
    expect(accountPickerChoices({ ...base, excludeAccounts: ["claude-one"] })
      .find((choice) => choice.value === "auto")?.disabled).toBe(false);
  });

  it("accountPickerChoices leaves quota and credit eligibility to live preflight, not account restrictions", () => {
    const choices = accountPickerChoices({
      gatewayOn: true,
      provider: "codex",
      pool: ["codex-main"],
      accountStates: { "codex-main": "unavailable" },
    });
    expect(choices.find((choice) => choice.value === "auto")?.disabled).toBe(false);
    expect(accountPickerChoices({ gatewayOn: false, provider: "codex", pool: ["codex-main"] })
      .some((choice) => choice.value === "auto")).toBe(false);
  });

  it("accountPickerChoices omits auto without a usable supported-provider pool", () => {
    expect(
      accountPickerChoices({ pool: [], provider: "codex" }).map(
        (choice) => choice.value,
      ),
    ).toEqual(["system"]);
    expect(
      accountPickerChoices({ pool: ["omp-main"], provider: "omp" }).map(
        (choice) => choice.value,
      ),
    ).toEqual(["system", "omp-main"]);
  });

  it('accountPickerChoices: the default row carries the LITERAL system escape hatch, never null/""', () => {
    // default-deploy-account-2026-08-08 P-004 D-002: server-side, an unspecified/`default` account
    // means "the owner's NOMINATED default account" — a GATEWAY route whenever one is configured.
    // Only `none`/`system` is guaranteed to stay on the machine's own login, so the row that
    // PROMISES "skip the inference gateway" must send exactly that. A null here is the 2026-08-19
    // silent misroute (su-254aa2e1 picked `default` and launched on the pool via :8788).
    const row = accountPickerChoices({
      gatewayOn: true,
      pool: ["aviynw8"],
      provider: "claude",
    })[0];
    expect(row.value).toBe("system");
    expect(accountRoutingMode(row.value)).toBe("default"); // …and the client still reads it as "skip the gateway"
    expect(row.name).toContain("skip the inference gateway");
  });

  it("accountProviderFromChoices: explicit null provider fails closed instead of falling back from the agent", () => {
    expect(accountProviderFromChoices({ provider: "claude" }, "codex")).toBe(
      "claude",
    );
    expect(accountProviderFromChoices({ provider: "codex" }, "claude")).toBe(
      "codex",
    );
    expect(accountProviderFromChoices({ provider: null }, "codex")).toBeNull();
    expect(accountProviderFromChoices({}, "codex")).toBe("codex");
  });

  it("planValue maps the NO_PLAN sentinel + empties to null", () => {
    expect(planValue(NO_PLAN)).toBeNull();
    expect(planValue("")).toBeNull();
    expect(planValue(null)).toBeNull();
    expect(planValue("real-plan")).toBe("real-plan");
  });

  it("selectionsFromArgs resolves --no-plan to a null plan + passes workspace", () => {
    expect(
      selectionsFromArgs({
        agent: "omp",
        workspace: "ws1",
        harness: "papercup",
        plan: null,
        noPlan: true,
      }),
    ).toEqual({
      agent: "omp",
      workspace: "ws1",
      harness: "papercup",
      plan: null,
    });
  });

  it("selectionsFromArgs keeps --plan when --no-plan is absent; null workspace when omitted", () => {
    expect(
      selectionsFromArgs({
        agent: "codex",
        workspace: null,
        harness: null,
        plan: "p",
        noPlan: false,
      }),
    ).toEqual({
      agent: "codex",
      workspace: null,
      harness: null,
      plan: "p",
    });
  });

  it("selectionsFromArgs rejects an unknown agent", () => {
    expect(() =>
      selectionsFromArgs({
        agent: "gemini",
        harness: "x",
        plan: null,
        noPlan: false,
      }),
    ).toThrow();
  });

  it("AGENTS lists exactly the three real backend kinds", () => {
    expect(AGENTS).toEqual(["claude", "omp", "codex"]);
  });

  it("presetsFromArgs: all flags preselect everything (no prompts needed)", () => {
    const p = presetsFromArgs(
      parseArgs([
        "--agent=claude",
        "--workspace=ws2",
        "--harness=papercup",
        "--plan=p",
      ]),
    );
    expect(p).toMatchObject({
      agent: "claude",
      workspace: "ws2",
      harness: "papercup",
      plan: "p",
      needAgent: false,
      needWorkspace: false,
      needHarness: false,
      needPlan: false,
    });
  });

  it("presetsFromArgs: no flags → everything needs a prompt", () => {
    const p = presetsFromArgs(parseArgs([]));
    expect(p).toMatchObject({
      agent: null,
      workspace: null,
      harness: null,
      plan: null,
      needAgent: true,
      needWorkspace: true,
      needHarness: true,
      needPlan: true,
    });
  });

  it("presetsFromArgs: partial preselect (agent + workspace) prompts only for harness + plan", () => {
    const p = presetsFromArgs(parseArgs(["--agent=omp", "--workspace=ws2"]));
    expect(p.agent).toBe("omp");
    expect(p.workspace).toBe("ws2");
    expect(p.needAgent).toBe(false);
    expect(p.needWorkspace).toBe(false);
    expect(p.needHarness).toBe(true);
    expect(p.needPlan).toBe(true);
  });

  it('presetsFromArgs: --no-plan preselects "no plan" (no plan prompt)', () => {
    const p = presetsFromArgs(parseArgs(["--agent=claude", "--no-plan"]));
    expect(p.plan).toBeNull();
    expect(p.needPlan).toBe(false);
  });

  it("presetsFromArgs: rejects a bad --agent", () => {
    expect(() => presetsFromArgs(parseArgs(["--agent=gemini"]))).toThrow();
  });

  it("parses --role and --feature", () => {
    const a = parseArgs([
      "--role=worker",
      "--feature=F-001",
      "--harness=papercup",
      "--agent=claude",
    ]);
    expect(a.role).toBe("worker");
    expect(a.feature).toBe("F-001");
  });
});

/**
 * P-021 (D-013). `--no-lsp` strips OMP's OWN `lsp` builtin as weak-model
 * tool-attractor suppression — it is NOT a statement about Papercusp's `lsp.*`
 * facade. These tests pin the two properties that matter at this layer:
 *   • DEFAULT UNCHANGED — absent an explicit allow, the builtin is still
 *     stripped, byte-identical to the pre-P-021 hard-coded literal. That is
 *     what makes the launcher half of this change a no-op until the server
 *     side says otherwise.
 *   • BOTH SITES — the role and su omp branches were two separate literals;
 *     a change applied to one is a half-applied change.
 * The safety invariant itself (a local model never gets the builtin) lives
 * server-side and is pinned in omp-native-lsp-gate.test.ts.
 */
describe("ompLspArgs (omp native lsp builtin)", () => {
  it("strips the builtin by default — absent/false/undefined all mean strip", () => {
    expect(ompLspArgs(undefined)).toEqual(["--no-lsp"]);
    expect(ompLspArgs(false)).toEqual(["--no-lsp"]);
  });

  it("keeps the builtin only on an explicit boolean true", () => {
    expect(ompLspArgs(true)).toEqual([]);
  });

  it("does not truthy-coerce — a stray string never opens the gate", () => {
    // The value arrives from an env comparison, so anything non-boolean
    // reaching here is a bug; it must fail closed rather than open.
    expect(ompLspArgs("1" as unknown as boolean)).toEqual(["--no-lsp"]);
    expect(ompLspArgs(1 as unknown as boolean)).toEqual(["--no-lsp"]);
  });

  it("BOTH omp branches honour it — role and su were separate literals", () => {
    const role = roleLaunchArgs("omp", {
      promptFile: "/p.md",
      allowNativeLsp: true,
    });
    const su = suLaunchArgs("omp", {
      promptFile: "/p.md",
      allowNativeLsp: true,
    });
    expect(role.args).not.toContain("--no-lsp");
    expect(su.args).not.toContain("--no-lsp");

    // CONTROL: the same two calls WITHOUT the allow still strip. Without this
    // the assertions above would pass against a build that dropped `--no-lsp`
    // unconditionally — the regression this feature could plausibly cause.
    expect(roleLaunchArgs("omp", { promptFile: "/p.md" }).args).toContain(
      "--no-lsp",
    );
    expect(suLaunchArgs("omp", { promptFile: "/p.md" }).args).toContain(
      "--no-lsp",
    );
  });

  it("never emits --no-lsp on non-omp backends (it is an omp flag)", () => {
    for (const backend of ["claude", "codex"]) {
      expect(suLaunchArgs(backend, { promptFile: "/p.md" }).args).not.toContain(
        "--no-lsp",
      );
      expect(
        suLaunchArgs(backend, { promptFile: "/p.md", allowNativeLsp: true })
          .args,
      ).not.toContain("--no-lsp");
    }
  });
});

describe("roleLaunchArgs (interactive role session)", () => {
  const files = {
    promptFile: "/lc/session-7.md",
    mcpJsonPath: "/proj/.mcp.json",
  };

  it("EI-204995: a scripted headless role keeps the env kickoff out of argv", () => {
    const provenanceDir = mkdtempSync(join(tmpdir(), "role-kickoff-prov-"));
    try {
      const parsed = parseArgs([
        "--no-picker",
        "--agent=claude",
        "--headless",
        "--role=judge",
        "--add-dir=/evidence",
        "--",
        "--effort",
        "high",
      ]);
      const env = {
        PAPERCUSP_KICKOFF_PROMPT: "Grade the frozen acceptance evidence.",
        PAPERCUSP_SID: "role-judge-1",
        PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
      };
      const result = finalizeFreshRoleArgs(
        "claude",
        ["--permission-mode", "bypassPermissions"],
        { envelopeEnv: { PAPERCUSP_SID: "role-judge-1" } },
        parsed,
        env,
      );

      expect(result.kickoffSeeded).toBe(true);
      expect(result.args).toEqual([
        "--permission-mode",
        "bypassPermissions",
        "--add-dir=/evidence",
        "--effort",
        "high",
      ]);
      expect(result.kickoff).toMatch(
        /^⟦turn-origin:fleet-kickoff nonce:[a-f0-9]{16}⟧\nGrade the frozen acceptance evidence\.$/,
      );
      const rows = readFileSync(
        join(provenanceDir, "role-judge-1.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n");
      expect(JSON.parse(rows.at(-1)!)).toMatchObject({
        sid: "role-judge-1",
        origin: "fleet-kickoff",
      });
    } finally {
      rmSync(provenanceDir, { recursive: true, force: true });
    }
  });

  it("routes a scripted headless OMP role kickoff to the managed pty, not argv", () => {
    const provenanceDir = mkdtempSync(join(tmpdir(), "role-omp-kickoff-prov-"));
    try {
      const parsed = parseArgs([
        "--no-picker",
        "--agent=omp",
        "--headless",
        "--role=judge",
      ]);
      const result = finalizeFreshRoleArgs(
        "omp",
        ["--extension", "/home/user/.papercusp-coord.ts"],
        { envelopeEnv: { PAPERCUSP_SID: "role-omp-1" } },
        parsed,
        {
          PAPERCUSP_KICKOFF_PROMPT: "Grade the frozen acceptance evidence.",
          PAPERCUSP_SID: "role-omp-1",
          PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
        },
      );

      expect(result.kickoffSeeded).toBe(true);
      expect(result.args).toEqual([
        "--extension",
        "/home/user/.papercusp-coord.ts",
      ]);
      expect(result.kickoff).toMatch(
        /^⟦turn-origin:fleet-kickoff nonce:[a-f0-9]{16}⟧\nGrade the frozen acceptance evidence\.$/,
      );
    } finally {
      rmSync(provenanceDir, { recursive: true, force: true });
    }
  });

  it("claude: raw claude, role prompt, strict role-scoped MCP, skip perms, scheduler lockout, no-subagent-fanout", () => {
    const { bin, args } = roleLaunchArgs("claude", files);
    expect(bin).toBe("claude");
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--system-prompt-file",
      "/lc/session-7.md",
      "--exclude-dynamic-system-prompt-sections",
      "--mcp-config",
      "/proj/.mcp.json",
      "--strict-mcp-config",
      "--permission-mode",
      "bypassPermissions",
      NATIVE_SCHEDULER_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
      NO_SUBAGENTS_DENY_FLAG,
    ]);
  });

  it("the scheduler lockout literal stays in LOCKSTEP with the canonical TS module (native-scheduler-lockout P-005)", () => {
    // psu-launcher.mjs is a plain-node script that can't import TS, so it
    // duplicates the rendered flag; this pins the copy to the source of truth.
    expect(NATIVE_SCHEDULER_DENY_FLAG).toBe(nativeSchedulerDenyFlag());
  });

  it("the scheduler lockout is one `=` token (the variadic space form would eat following args)", () => {
    expect(NATIVE_SCHEDULER_DENY_FLAG.startsWith("--disallowedTools=")).toBe(
      true,
    );
    expect(/\s/.test(NATIVE_SCHEDULER_DENY_FLAG)).toBe(false);
  });

  // ── su scheduler-TOOLS lockout (agent-launch-context-cost-2026-09-18 P-006) ──
  const denyNames = (flag: string) =>
    flag.slice("--disallowedTools=".length).split(",");

  it("the su scheduler-TOOLS literal stays in LOCKSTEP with the canonical TS module (P-006)", () => {
    // Same reason as the full flag: psu-launcher.mjs can't import TS, so it
    // duplicates the rendered token; this pins the copy to the source of truth.
    expect(SU_SCHEDULER_TOOLS_DENY_FLAG).toBe(suSchedulerToolsDenyFlag());
  });

  it("the su scheduler-TOOLS lockout is one `=` token (same variadic greed-guard)", () => {
    expect(SU_SCHEDULER_TOOLS_DENY_FLAG.startsWith("--disallowedTools=")).toBe(
      true,
    );
    expect(/\s/.test(SU_SCHEDULER_TOOLS_DENY_FLAG)).toBe(false);
  });

  it("the su scheduler-TOOLS deny is a STRICT SUBSET of the full lockout — it can never widen it", () => {
    const su = denyNames(SU_SCHEDULER_TOOLS_DENY_FLAG);
    const full = denyNames(NATIVE_SCHEDULER_DENY_FLAG);
    expect(su.length).toBeGreaterThan(0);
    for (const name of su) expect(full).toContain(name);
    expect(su.length).toBeLessThan(full.length);
  });

  it("the su scheduler-TOOLS deny EXCLUDES the owner-facing skills — D-003's carve-out survives", () => {
    // This is the assertion that keeps the cost fix from quietly becoming a
    // capability removal: `/schedule` and `/loop` are what the HUMAN types, and
    // D-003 preserves them. Denying them here would be a silent regression.
    const su = denyNames(SU_SCHEDULER_TOOLS_DENY_FLAG);
    for (const skill of NATIVE_SCHEDULER_SKILL_DENY)
      expect(su).not.toContain(skill);
    // ...and it carries every model-facing TOOL, which is the whole point.
    for (const tool of NATIVE_SCHEDULER_TOOL_DENY) expect(su).toContain(tool);
  });

  it("the full lockout is DERIVED from its two halves — the subsets cannot drift from the union", () => {
    expect([...NATIVE_SCHEDULER_DENY]).toEqual([
      ...NATIVE_SCHEDULER_TOOL_DENY,
      ...NATIVE_SCHEDULER_SKILL_DENY,
    ]);
  });

  it("the dead-weight lockout is one `=` token of BARE NATIVE names (context-baseline repair 2026-09-15)", () => {
    // Same greed-guard as the flags above: the variadic space form eats following argv.
    expect(NATIVE_DEADWEIGHT_DENY_FLAG.startsWith("--disallowedTools=")).toBe(
      true,
    );
    expect(/\s/.test(NATIVE_DEADWEIGHT_DENY_FLAG)).toBe(false);
    const names = NATIVE_DEADWEIGHT_DENY_FLAG.slice(
      "--disallowedTools=".length,
    ).split(",");
    expect(names.length).toBeGreaterThan(0);
    // MEASURED 2026-09-15 on a captured /v1/messages body, both directions:
    // denying a NATIVE name strips its schema from the wire (Artifact 871,924 ->
    // 822,141 B, zero occurrences left), while an `mcp__*` name in the SAME token
    // left mcp__claude-in-chrome__navigate's schema in the body verbatim. So an
    // mcp__ entry here buys nothing — drop the SERVER instead. Guard the rule.
    for (const n of names) {
      expect(n.startsWith("mcp__")).toBe(false);
      // Bare names only: a parenthesized specifier belongs in its own token.
      expect(n).not.toContain("(");
    }
    // D-003 keeps claude's schedulers for the human `psu su` session — they are
    // the owner's own `/schedule` surface and must never be swept in here.
    for (const reserved of ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"]) {
      expect(names).not.toContain(reserved);
    }
  });

  it("the owner-desktop notify-send lockout stays in LOCKSTEP with the canonical TS module (owner directive 2026-07-14)", () => {
    expect(OWNER_DESKTOP_NOTIFY_DENY_FLAG).toBe(ownerDesktopNotifyDenyFlag());
    expect(
      OWNER_DESKTOP_NOTIFY_DENY_FLAG.startsWith("--disallowedTools="),
    ).toBe(true);
    expect(/\s/.test(OWNER_DESKTOP_NOTIFY_DENY_FLAG)).toBe(false);
  });

  it("the notify-send lockout is UNCONDITIONAL on every claude launch shape — su + role + resume, even with allowSubagents:true", () => {
    expect(roleLaunchArgs("claude", files).args).toContain(
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
    );
    expect(suLaunchArgs("claude", { promptFile: "/p.md" }).args).toContain(
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
    );
    expect(
      suLaunchArgs("claude", { promptFile: "/p.md", allowSubagents: true })
        .args,
    ).toContain(OWNER_DESKTOP_NOTIFY_DENY_FLAG);
    expect(resumeArgsFor({ agent: "claude", cwd: "/x" }).args).toContain(
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
    );
    expect(
      resumeArgsFor({ agent: "claude", cwd: "/x" }, { allowSubagents: true })
        .args,
    ).toContain(OWNER_DESKTOP_NOTIFY_DENY_FLAG);
  });

  it("the no-subagent-fanout deny carries Task + Agent + Workflow (no-subagent-deny.ts)", () => {
    // psu-launcher.mjs duplicates the rendered flag from the canonical TS source
    // (same lockstep pattern as the scheduler-deny flag above).
    expect(NO_SUBAGENTS_DENY_FLAG).toBe(noSubagentToolsDenyFlag());
    expect(NO_SUBAGENTS_DENY_FLAG.startsWith("--disallowedTools=")).toBe(true);
    expect(/\s/.test(NO_SUBAGENTS_DENY_FLAG)).toBe(false);
    expect(NO_SUBAGENTS_DENY_FLAG).toContain("Task");
    expect(NO_SUBAGENTS_DENY_FLAG).toContain("Agent");
    // Workflow: the separate multi-agent orchestration tool that slipped the deny
    // (a subagents-denied psu --resume session still fanned out through it).
    expect(NO_SUBAGENTS_DENY_FLAG).toContain("Workflow");
  });

  it("the native tool-search deny carries ToolSearch (native-tool-search-deny.ts)", () => {
    // psu-launcher.mjs duplicates the rendered flag from the canonical TS source
    // (same lockstep pattern as the two deny flags above).
    expect(NATIVE_TOOL_SEARCH_DENY_FLAG).toBe(nativeToolSearchDenyFlag());
    expect(NATIVE_TOOL_SEARCH_DENY_FLAG.startsWith("--disallowedTools=")).toBe(
      true,
    );
    expect(/\s/.test(NATIVE_TOOL_SEARCH_DENY_FLAG)).toBe(false);
    expect(NATIVE_TOOL_SEARCH_DENY_FLAG).toContain("ToolSearch");
    // It must NOT deny the papercusp replacements it exists to route onto —
    // denying either would strand every session.
    expect(NATIVE_TOOL_SEARCH_DENY_FLAG).not.toContain("tools_invoke");
    expect(NATIVE_TOOL_SEARCH_DENY_FLAG).not.toContain("tools_find");
  });

  it("every psu launch surface denies the native tool search UNCONDITIONALLY (no opt-in)", () => {
    // Unlike subagents there is no opt-in: tools:find/tools:invoke fully cover
    // the capability, so allowSubagents must NOT re-enable ToolSearch either.
    expect(suLaunchArgs("claude", { promptFile: "/p.md" }).args).toContain(
      NATIVE_TOOL_SEARCH_DENY_FLAG,
    );
    expect(
      suLaunchArgs("claude", { promptFile: "/p.md", allowSubagents: true })
        .args,
    ).toContain(NATIVE_TOOL_SEARCH_DENY_FLAG);
    expect(roleLaunchArgs("claude", files).args).toContain(
      NATIVE_TOOL_SEARCH_DENY_FLAG,
    );
  });

  // P-007 (agent-launch-context-cost-2026-09-18). ENABLE_TOOL_SEARCH exists for exactly one
  // job: forcing claude's native schema deferral back on for gateway-routed sessions. That
  // deferral is conditional on ToolSearch EXISTING, which psu denies. Both halves shipped
  // independently and contradicted each other in production for days while each read healthy
  // on its own — so the pair is now DERIVED rather than detected, and these pin the derivation.
  describe("ENABLE_TOOL_SEARCH × the ToolSearch deny cannot contradict (P-007)", () => {
    it("lockstep: the launcher mirror agrees with the canonical orchestrator predicate", () => {
      expect(nativeDeferralReachable()).toBe(canonicalNativeDeferralReachable());
      // Today's state, stated explicitly so a change has to be deliberate.
      expect(nativeDeferralReachable()).toBe(false);
    });

    it("is a REAL derivation, not a hardcoded false — remove ToolSearch and deferral returns", () => {
      // The load-bearing assertion of this whole item. A test that only checked "the env is
      // absent" would pass identically against `return false`, which would silently strand the
      // env forever if the owner ever lifts the 2026-09-11 lockout. Drive the predicate from a
      // deny flag that does NOT carry ToolSearch and it must flip.
      expect(nativeDeferralReachable("--disallowedTools=SomethingElse")).toBe(true);
      expect(nativeDeferralReachable("--disallowedTools=")).toBe(true);
      expect(nativeDeferralReachable("--disallowedTools=A,ToolSearch,B")).toBe(false);
      // Whitespace-padded entries must still be recognised, or the derivation silently
      // reports "reachable" for a deny that is actually in force.
      expect(nativeDeferralReachable("--disallowedTools=A, ToolSearch")).toBe(false);
      // Canonical side too, driven by name list rather than flag string.
      expect(canonicalNativeDeferralReachable(["SomethingElse"])).toBe(true);
      expect(canonicalNativeDeferralEnv(["SomethingElse"])).toEqual({
        ENABLE_TOOL_SEARCH: "true",
      });
      expect(canonicalNativeDeferralEnv()).toEqual({});
    });

    it("contextTrimmingEnv omits ENABLE_TOOL_SEARCH while ToolSearch is denied", () => {
      const claude = contextTrimmingEnv("claude");
      expect(claude.ENABLE_TOOL_SEARCH).toBeUndefined();
      // The keys that are unconditionally correct must SURVIVE — this fix removes one key,
      // it does not disarm context trimming (PAPERCUSP_TOOLS is what actually holds the
      // baseline now that native deferral is off fleet-wide).
      expect(claude.PAPERCUSP_TOOLS).toBeTypeOf("string");
      expect(claude.PAPERCUSP_CONTEXT_TIER).toBe("trimmed");
    });

    it("NO claude launch path emits the deny AND ENABLE_TOOL_SEARCH together", () => {
      // The invariant itself, asserted against every arg builder rather than the one that
      // happened to be edited. Reading a deny literal out of ONE builder is what produced the
      // wrong diagnosis this plan already had to retract once.
      const paths: Array<[string, string[]]> = [
        ["suLaunchArgs", suLaunchArgs("claude", { promptFile: "/p.md" }).args],
        ["roleLaunchArgs", roleLaunchArgs("claude", files).args],
        ["resumeArgsFor", resumeArgsFor({ agent: "claude", cwd: "/x" }).args],
      ];
      const env = contextTrimmingEnv("claude");
      for (const [name, args] of paths) {
        const denies = args.includes(NATIVE_TOOL_SEARCH_DENY_FLAG);
        expect(denies, `${name} must deny ToolSearch`).toBe(true);
        expect(
          denies && env.ENABLE_TOOL_SEARCH !== undefined,
          `${name} emits the ToolSearch deny AND ENABLE_TOOL_SEARCH — that pair injects a ` +
            `DeferredToolPlaceholder for an empty deferred set on every request`,
        ).toBe(false);
      }
    });

    it("healContextTrimmingEnv STRIPS a carried ENABLE_TOOL_SEARCH from older host code", () => {
      // Fill-only healing cannot converge here: a host-code handoff is written by the
      // predecessor's in-memory (OLD) code, which set this key unconditionally, so it arrives
      // already present and every fill-only path leaves it. Without the strip, adopting the
      // fixed code would never clear the state the fix exists to remove.
      const env: Record<string, string | undefined> = {
        PAPERCUSP_AGENT: "claude",
        ENABLE_TOOL_SEARCH: "true",
      };
      healContextTrimmingEnv(env, "claude");
      expect(env.ENABLE_TOOL_SEARCH).toBeUndefined();
      // Non-claude agents never had the key and must be left alone.
      const omp: Record<string, string | undefined> = { PAPERCUSP_AGENT: "omp" };
      healContextTrimmingEnv(omp, "omp");
      expect(omp.ENABLE_TOOL_SEARCH).toBeUndefined();
    });
  });

  it("role sessions DENY subagent fanout by DEFAULT; allowSubagents:true opts in (owner mandate 2026-07-02)", () => {
    expect(roleLaunchArgs("claude", files).args).toContain(
      NO_SUBAGENTS_DENY_FLAG,
    );
    expect(
      roleLaunchArgs("claude", { ...files, allowSubagents: true }).args,
    ).not.toContain(NO_SUBAGENTS_DENY_FLAG);
  });

  describe("subagentGatewayRiskNotice (EI-3294)", () => {
    it("warns ONLY for claude + allowSubagents + the default (non-gateway) account route", () => {
      expect(
        subagentGatewayRiskNotice("claude", true, {
          PAPERCUSP_ACCOUNT_ROUTING_MODE: "default",
        }),
      ).toMatch(/EI-3294/);
    });

    it("stays silent when subagents are not enabled", () => {
      expect(
        subagentGatewayRiskNotice("claude", false, {
          PAPERCUSP_ACCOUNT_ROUTING_MODE: "default",
        }),
      ).toBeNull();
      expect(
        subagentGatewayRiskNotice("claude", null, {
          PAPERCUSP_ACCOUNT_ROUTING_MODE: "default",
        }),
      ).toBeNull();
    });

    it("stays silent once the route is gateway-routed (auto or a pinned account) — the whole point is it sidesteps the risk", () => {
      expect(
        subagentGatewayRiskNotice("claude", true, {
          PAPERCUSP_ACCOUNT_ROUTING_MODE: "auto",
        }),
      ).toBeNull();
      expect(subagentGatewayRiskNotice("claude", true, {})).toBeNull();
      expect(subagentGatewayRiskNotice("claude", true, undefined)).toBeNull();
    });

    it("stays silent for non-claude backends (subagent deny/allow is claude-only)", () => {
      expect(
        subagentGatewayRiskNotice("omp", true, {
          PAPERCUSP_ACCOUNT_ROUTING_MODE: "default",
        }),
      ).toBeNull();
      expect(
        subagentGatewayRiskNotice("codex", true, {
          PAPERCUSP_ACCOUNT_ROUTING_MODE: "default",
        }),
      ).toBeNull();
    });
  });

  // P-019/D-007 (voice-public-release-readiness-2026-07-12): role sessions silently
  // DROPPED --model (env-only PAPERCUSP_MODEL) — the "fast" sonnet pane launched on
  // the box's saved default (Opus). Pin the claude branch to emit real model argv.
  it("claude: --model spec becomes real argv with effort split (was silently dropped — voice pane ran Opus)", () => {
    const { args } = roleLaunchArgs("claude", {
      ...files,
      model: "sonnet:medium",
    });
    const modelAt = args.indexOf("--model");
    expect(modelAt).toBeGreaterThan(-1);
    expect(args.slice(modelAt, modelAt + 4)).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "medium",
    ]);
  });

  it("claude: bare model spec passes through verbatim; no model ⇒ no --model/--effort argv", () => {
    const bare = roleLaunchArgs("claude", {
      ...files,
      model: "claude-sonnet-5",
    });
    const at = bare.args.indexOf("--model");
    expect(bare.args.slice(at, at + 2)).toEqual(["--model", "claude-sonnet-5"]);
    expect(bare.args).not.toContain("--effort");

    const none = roleLaunchArgs("claude", files);
    expect(none.args).not.toContain("--model");
    expect(none.args).not.toContain("--effort");
  });

  it("omp: raw omp, role prompt file, yolo approvals (path-discovers .mcp.json)", () => {
    const { bin, args } = roleLaunchArgs("omp", files);
    expect(bin).toBe("omp");
    expect(args).toEqual([
      "--approval-mode",
      "yolo",
      "--no-lsp",
      "--system-prompt",
      "/lc/session-7.md",
      "--no-title",
    ]);
  });

  it("omp: keeps the native lsp builtin when the server-resolved gate allows it (P-021/D-013)", () => {
    const { args } = roleLaunchArgs("omp", { ...files, allowNativeLsp: true });
    expect(args).not.toContain("--no-lsp");
    expect(args).toEqual([
      "--approval-mode",
      "yolo",
      "--system-prompt",
      "/lc/session-7.md",
      "--no-title",
    ]);
  });

  it("omp: loads the coordination extension (-e) when a coordExtPath is supplied (lock + activity bridge)", () => {
    const { args } = roleLaunchArgs("omp", {
      ...files,
      coordExtPath: "/h/.papercusp/papercusp-coord.ts",
    });
    expect(args).toEqual([
      "--approval-mode",
      "yolo",
      "--no-lsp",
      "--system-prompt",
      "/lc/session-7.md",
      "--no-title",
      "-e",
      "/h/.papercusp/papercusp-coord.ts",
    ]);
  });

  it("omp: omits -e when no coordExtPath is supplied", () => {
    const { args } = roleLaunchArgs("omp", files);
    expect(args).not.toContain("-e");
  });

  it("omp: --model spec becomes native model argv", () => {
    const { args } = roleLaunchArgs("omp", { ...files, model: "sonnet:high" });
    const modelAt = args.indexOf("--model");
    expect(args.slice(modelAt, modelAt + 2)).toEqual([
      "--model",
      "sonnet:high",
    ]);
  });

  it("codex: raw codex, hook-trust + approvals/sandbox bypass (CODEX_HOME via envelopeEnv)", () => {
    const { bin, args } = roleLaunchArgs("codex", {
      ...files,
      model: "gpt-5.6-sol:xhigh",
    });
    expect(bin).toBe("codex");
    expect(args).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      "model_context_window=1000000",
      "-c",
      "model_auto_compact_token_limit=900000",
    ]);
  });

  it("codex: --model spec becomes model and reasoning-effort argv", () => {
    const { args } = roleLaunchArgs("codex", { ...files, model: "gpt-5:high" });
    expect(args.slice(-4)).toEqual([
      "-m",
      "gpt-5",
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });

  it("unknown backend: throws", () => {
    expect(() => roleLaunchArgs("gemini", files)).toThrow();
  });

  // identities-v1 D-018 / D-021 / WI-2143907: sealed replacement has no append branch.
  it("claude unconditionally REPLACES the base (--system-prompt-file + --exclude-dynamic), MCP + lockout intact", () => {
    const { args } = roleLaunchArgs("claude", files);
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--system-prompt-file",
      "/lc/session-7.md",
      "--exclude-dynamic-system-prompt-sections",
      "--mcp-config",
      "/proj/.mcp.json",
      "--strict-mcp-config",
      "--permission-mode",
      "bypassPermissions",
      NATIVE_SCHEDULER_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
      NO_SUBAGENTS_DENY_FLAG,
    ]);
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("omp unconditionally uses --system-prompt (replace) instead of --append", () => {
    const { args } = roleLaunchArgs("omp", {
      ...files,
      coordExtPath: "/h/coord.ts",
    });
    expect(args).toEqual([
      "--approval-mode",
      "yolo",
      "--no-lsp",
      "--system-prompt",
      "/lc/session-7.md",
      "--no-title",
      "-e",
      "/h/coord.ts",
    ]);
  });

  it("codex needs no replacement switch (CODEX_HOME AGENTS.md is already the whole prompt)", () => {
    expect(
      roleLaunchArgs("codex", {
        ...files,
        model: "gpt-5.6-sol:xhigh",
      }).args,
    ).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      "model_context_window=1000000",
      "-c",
      "model_auto_compact_token_limit=900000",
    ]);
  });

  it("agentInvalidForRole accepts claude/omp/codex", () => {
    expect(agentInvalidForRole("claude")).toBe(false);
    expect(agentInvalidForRole("omp")).toBe(false);
    expect(agentInvalidForRole("codex")).toBe(false);
    expect(agentInvalidForRole(null)).toBe(true);
    expect(agentInvalidForRole("gemini")).toBe(true);
  });
});

describe("suLaunchArgs (P-020 raw-CLI su launch, mirrors roleLaunchArgs)", () => {
  const files = {
    promptFile: "/lc/session-9.md",
    coordExtPath: "/home/u/.papercusp/papercusp-coord.ts",
  };

  it("claude: playbook prompt + skip-perms, NO --mcp-config (papercusp-su is user-level)", () => {
    const { bin, args } = suLaunchArgs("claude", files);
    expect(bin).toBe("claude");
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--system-prompt-file",
      "/lc/session-9.md",
      "--exclude-dynamic-system-prompt-sections",
      "--permission-mode",
      "bypassPermissions",
      // Subagent deny is DEFAULT-ON as of the 2026-07-02 owner mandate.
      NO_SUBAGENTS_DENY_FLAG,
      // Native tool-search deny is unconditional with NO opt-in (2026-09-11):
      // papercusp's tools:find/tools:invoke fully cover the capability.
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      // notify-send lockout is unconditional — su sessions included (2026-07-14).
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      // Model-facing scheduler TOOLS (2026-09-18): 9,156 B of schemas per turn
      // for tools the su playbook already forbids. STRICT SUBSET of the full
      // lockout — the owner's Skill(schedule)/Skill(loop) survive (D-003).
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      // Dead-weight native tools (2026-09-15): ~75,000 B of schemas that ride
      // EVERY prompt while ToolSearch deferral is off. See its doc comment.
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
    ]);
    // su relies on the user-level papercusp-su MCP (no per-launch --mcp-config),
    // so the user's full toolkit loads (D-005) and the server isn't doubled.
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("claude su: the HUMAN session keeps native SCHEDULERS — NO full scheduler-lockout flag (native-scheduler-lockout D-003)", () => {
    const { args } = suLaunchArgs("claude", files);
    // D-003 for SCHEDULERS still holds — assert the scheduler-deny specifically, NOT
    // the mere presence of a --disallowedTools token: the subagent deny is now
    // default-ON (owner mandate 2026-07-02) and adds its own --disallowedTools.
    expect(args).not.toContain(NATIVE_SCHEDULER_DENY_FLAG);
    // ...and specifically the OWNER's surface survives: `/schedule` + `/loop`
    // must appear in NO deny token this launch carries (P-006 narrowed the su
    // deny to the model-facing TOOLS only — see the subset tests above).
    const denyTokens = args.filter((a) => a.startsWith("--disallowedTools="));
    for (const skill of NATIVE_SCHEDULER_SKILL_DENY)
      expect(denyTokens.join(",")).not.toContain(skill);
  });

  it("claude su: DENIES the model-facing scheduler TOOLS — 9,156 B/turn the playbook already forbids (P-006)", () => {
    const { args } = suLaunchArgs("claude", files);
    expect(args).toContain(SU_SCHEDULER_TOOLS_DENY_FLAG);
  });

  it("claude su: DENIES the subagent tool by DEFAULT (owner mandate 2026-07-02 — inverted the D-003 carve-out)", () => {
    const { args } = suLaunchArgs("claude", files);
    expect(args).toContain(NO_SUBAGENTS_DENY_FLAG);
  });

  it("claude su: allowSubagents:true opts the human session back IN to the subagent tool (owner mandate 2026-07-02)", () => {
    const { args } = suLaunchArgs("claude", { ...files, allowSubagents: true });
    expect(args).not.toContain(NO_SUBAGENTS_DENY_FLAG);
  });

  it("omp: yolo + playbook prompt + coordination extension (-e, P-021)", () => {
    const { bin, args } = suLaunchArgs("omp", files);
    expect(bin).toBe("omp");
    expect(args).toEqual([
      "--approval-mode",
      "yolo",
      "--no-lsp",
      "--system-prompt",
      "/lc/session-9.md",
      "--no-title",
      "-e",
      "/home/u/.papercusp/papercusp-coord.ts",
    ]);
  });

  it("omp: omits -e when no coordExtPath is supplied", () => {
    const { args } = suLaunchArgs("omp", { promptFile: "/lc/s.md" });
    expect(args).toEqual([
      "--approval-mode",
      "yolo",
      "--no-lsp",
      "--system-prompt",
      "/lc/s.md",
      "--no-title",
    ]);
    expect(args).not.toContain("-e");
  });

  it("codex: hook-trust + approvals/sandbox bypass (CODEX_HOME minted server-side, P-030)", () => {
    const { bin, args } = suLaunchArgs("codex", files);
    expect(bin).toBe("codex");
    expect(args).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
    ]);
  });

  it("claude: forces --session-id when a nativeSessionId is supplied (resume-by-uuid correlation)", () => {
    const { args } = suLaunchArgs("claude", {
      promptFile: "/lc/s.md",
      nativeSessionId: "uuid-9",
    });
    // --session-id sits between the replacement prompt and the permission mode; it
    // makes `psu --resume uuid-9` match the tracked adv row + resume the EXACT session.
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--system-prompt-file",
      "/lc/s.md",
      "--exclude-dynamic-system-prompt-sections",
      "--session-id",
      "uuid-9",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
    ]);
  });

  it("claude: omits --session-id when no nativeSessionId is given", () => {
    expect(
      suLaunchArgs("claude", { promptFile: "/lc/s.md" }).args,
    ).not.toContain("--session-id");
  });

  it("omp/codex: ignore nativeSessionId (no forced session id on those backends)", () => {
    expect(
      suLaunchArgs("omp", { promptFile: "/lc/s.md", nativeSessionId: "uuid-9" })
        .args,
    ).not.toContain("--session-id");
    expect(
      suLaunchArgs("codex", {
        promptFile: "/lc/s.md",
        nativeSessionId: "uuid-9",
      }).args,
    ).not.toContain("--session-id");
  });

  it("unknown backend: throws", () => {
    expect(() => suLaunchArgs("gemini", files)).toThrow();
  });

  // identities-v1 D-018 / D-021 / WI-2143907: sealed replacement has no append branch.
  it("claude unconditionally REPLACES the base (--system-prompt-file + --exclude-dynamic)", () => {
    const { args } = suLaunchArgs("claude", files);
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--system-prompt-file",
      "/lc/session-9.md",
      "--exclude-dynamic-system-prompt-sections",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
    ]);
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("omp unconditionally uses --system-prompt (replace) instead of --append", () => {
    const { args } = suLaunchArgs("omp", files);
    expect(args).toEqual([
      "--approval-mode",
      "yolo",
      "--no-lsp",
      "--system-prompt",
      "/lc/session-9.md",
      "--no-title",
      "-e",
      "/home/u/.papercusp/papercusp-coord.ts",
    ]);
    expect(args).not.toContain("--append-system-prompt");
  });

  it("codex needs no replacement switch (AGENTS.md is already the whole prompt)", () => {
    expect(suLaunchArgs("codex", files).args).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
    ]);
  });

  it("unconditional Claude replacement still forces --session-id when given", () => {
    const { args } = suLaunchArgs("claude", {
      promptFile: "/lc/s.md",
      nativeSessionId: "uuid-9",
    });
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--system-prompt-file",
      "/lc/s.md",
      "--exclude-dynamic-system-prompt-sections",
      "--session-id",
      "uuid-9",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
    ]);
  });
});

describe("normalizeModelSpec (opus/fable → 1M window; owner directive 2026-07-02)", () => {
  it("injects [1m] for a bare opus/fable spec", () => {
    expect(normalizeModelSpec("opus")).toBe("opus[1m]");
    expect(normalizeModelSpec("claude-fable-5")).toBe("claude-fable-5[1m]");
    expect(normalizeModelSpec("fable")).toBe("fable[1m]");
  });
  it("inserts [1m] BEFORE a recognized :effort suffix (so effort still splits out)", () => {
    expect(normalizeModelSpec("claude-fable-5:xhigh")).toBe(
      "claude-fable-5[1m]:xhigh",
    );
    expect(normalizeModelSpec("opus:high")).toBe("opus[1m]:high");
    expect(normalizeModelSpec("opus:max")).toBe("opus[1m]:max");
  });
  it("is idempotent — a spec already carrying [1m] is unchanged", () => {
    expect(normalizeModelSpec("opus[1m]")).toBe("opus[1m]");
    expect(normalizeModelSpec("claude-fable-5[1m]:xhigh")).toBe(
      "claude-fable-5[1m]:xhigh",
    );
  });
  it("injects [1m] for the sonnet-5 family too (its native 1M default is statsig-gated OFF — the marker is the only reliable path); no-op for non-1M families and empty specs", () => {
    expect(normalizeModelSpec("sonnet")).toBe("sonnet[1m]");
    expect(normalizeModelSpec("sonnet:high")).toBe("sonnet[1m]:high");
    expect(normalizeModelSpec("claude-sonnet-5:high")).toBe(
      "claude-sonnet-5[1m]:high",
    );
    expect(normalizeModelSpec("haiku")).toBe("haiku");
    expect(normalizeModelSpec("")).toBe("");
    expect(normalizeModelSpec(undefined)).toBeUndefined();
    expect(normalizeModelSpec(null)).toBeNull();
  });
  it("a non-effort `:` segment is treated as part of the id (marker appended at end)", () => {
    // A bedrock-style id whose tail is not an effort level: [1m] appends, not mid-string.
    expect(normalizeModelSpec("opus-v2:0")).toBe("opus-v2:0[1m]");
  });
  it("parseArgs applies it — a fleet opus/fable launch spec lands normalized", () => {
    expect(parseArgs(["--model=claude-fable-5:xhigh"]).model).toBe(
      "claude-fable-5[1m]:xhigh",
    );
    expect(parseArgs(["--model=opus:max"]).model).toBe("opus[1m]:max");
    expect(parseArgs(["--model=sonnet:high"]).model).toBe("sonnet[1m]:high");
  });
});

describe("composeResumeModelSpec + resume model menu (WI-4889 — menu, not free-text)", () => {
  it("composes base + effort into the psu spec", () => {
    expect(composeResumeModelSpec("sol", "xhigh")).toBe("sol:xhigh"); // codex, open-set, no [1m]
    expect(composeResumeModelSpec("opus", "high")).toBe("opus[1m]:high"); // 1M family → [1m] before effort
    expect(composeResumeModelSpec("sonnet", "max")).toBe("sonnet[1m]:max");
  });
  it("a blank effort drops the suffix (model default)", () => {
    expect(composeResumeModelSpec("haiku", "")).toBe("haiku"); // haiku is not a 1M family → no marker
    expect(composeResumeModelSpec("fable", "")).toBe("fable[1m]"); // 1M family still normalizes
    expect(composeResumeModelSpec("sol", "")).toBe("sol");
  });
  it("an empty / null / whitespace model → null (agent default)", () => {
    expect(composeResumeModelSpec("", "high")).toBeNull();
    expect(composeResumeModelSpec(null, "high")).toBeNull();
    expect(composeResumeModelSpec(undefined, "")).toBeNull();
    expect(composeResumeModelSpec("   ", "high")).toBeNull();
  });
  it("every base-model value is a lowercase alias validateModelSpec accepts, and includes sol", () => {
    const values = RESUME_MODEL_MENU.map((c) => c.value);
    expect(values).toContain("sol");
    for (const v of values) {
      expect(v, v).toBe(v.toLowerCase());
      expect(validateModelSpec(v).ok, v).toBe(true);
    }
  });
  it("effort values are a subset of the recognized efforts (+ the empty default)", () => {
    const allowed = new Set(["", "low", "medium", "high", "xhigh", "max"]);
    for (const c of RESUME_EFFORT_MENU)
      expect(allowed.has(c.value), c.value).toBe(true);
    expect(RESUME_EFFORT_MENU.map((c) => c.value)).toContain(""); // the model-default row
  });
  it("menu base + effort compose to a spec validateModelSpec still accepts", () => {
    // The menu can only ever produce specs the launcher would accept from --model.
    for (const m of RESUME_MODEL_MENU) {
      for (const e of RESUME_EFFORT_MENU) {
        const spec = composeResumeModelSpec(m.value, e.value);
        expect(spec, `${m.value}:${e.value || "(default)"}`).toBeTruthy();
        expect(validateModelSpec(String(spec)).ok, String(spec)).toBe(true);
      }
    }
  });
});

// WI-6300 (owner ask 2026-07-27: "why is the model list missing so many levels?
// Don't we have a list somewhere in our repo that launching our psu utility uses?").
// We DO — RESUME_MODEL_MENU / RESUME_EFFORT_MENU right here. The HUD's new-session
// launcher used to hand-maintain a rival 4-entry list that fell behind (no fable /
// sol / terra / luna, plus a stale `gpt-5.2` that is not even a recognized alias)
// and a 3-entry effort list missing xhigh/max. The launcher now derives from the
// operator-core twins; THIS suite is what makes the twins trustworthy — it fails
// the build the moment psu's menu and the UI's source of truth diverge.
describe("CLOUD_MODEL_MENU / MODEL_EFFORT_LEVELS ↔ psu menus parity (WI-6300)", () => {
  // psu-launcher.mjs ships no type declarations (it is exec'd directly by node),
  // so anything imported from it lands as `any`. Naming the row shape here keeps
  // these assertions from adding yet more implicit-any noise to this file.
  type PsuMenuRow = { name: string; value: string; backend?: string };
  const psuModels = RESUME_MODEL_MENU as PsuMenuRow[];
  const psuEffortRows = RESUME_EFFORT_MENU as PsuMenuRow[];

  it("CLOUD_MODEL_MENU carries EXACTLY psu's base models, in the same order", () => {
    expect(CLOUD_MODEL_MENU.map((c) => c.value)).toEqual(
      psuModels.map((c) => c.value),
    );
  });

  it("each twin row keeps psu's backend tag — a codex model can never be mislabelled claude", () => {
    for (const row of CLOUD_MODEL_MENU) {
      const psuRow = psuModels.find((c) => c.value === row.value);
      expect(psuRow, `no psu row for ${row.value}`).toBeTruthy();
      expect(row.backend, row.value).toBe(psuRow!.backend);
      // and the tag agrees with the launcher's own resolver, not just the literal
      expect(cloudModelBackendHint(row.value), row.value).toBe(row.backend);
    }
  });

  it('each twin label is psu\'s menu text minus the redundant "<alias> — " prefix', () => {
    for (const row of CLOUD_MODEL_MENU) {
      const psuRow = psuModels.find((c) => c.value === row.value);
      expect(psuRow!.name, row.value).toBe(`${row.value} — ${row.label}`);
    }
  });

  it("every twin value is a spec validateModelSpec accepts (bare and with every effort)", () => {
    for (const row of CLOUD_MODEL_MENU) {
      expect(validateModelSpec(row.value).ok, row.value).toBe(true);
      for (const effort of MODEL_EFFORT_LEVELS) {
        const spec = `${row.value}:${effort}`;
        expect(validateModelSpec(spec).ok, spec).toBe(true);
        // the operator-side tool-boundary twin must agree with the launcher
        expect(validateCloudModelSpec(spec).ok, spec).toBe(true);
      }
    }
  });

  it("MODEL_EFFORT_LEVELS is exactly psu's effort menu minus the empty model-default row", () => {
    const psuEfforts = psuEffortRows
      .map((c) => c.value)
      .filter((v) => v !== "");
    expect([...MODEL_EFFORT_LEVELS]).toEqual(psuEfforts);
    // the two the launcher was missing, pinned explicitly so a regression names itself
    expect([...MODEL_EFFORT_LEVELS]).toContain("xhigh");
    expect([...MODEL_EFFORT_LEVELS]).toContain("max");
  });
});

describe("SU_CONTEXT_SIZES / composeLaunchModelSpec ↔ psu parity (WI-6321)", () => {
  // Owner ask 2026-07-27: the GUI "should share the same code for getting the
  // options". The fleet + account lists are genuinely shared at RUNTIME (both psu
  // and the GUI read /api/agent-mcp/console/bootstrap-su/options), so there is no
  // second list to pin. The STATIC vocabularies below are twins by necessity —
  // psu-launcher.mjs cannot be imported by the browser bundle — so they are pinned
  // here, exactly as WI-6300 pinned the model/effort menus.

  it("SU_CONTEXT_SIZES is exactly psu's context-size choices minus the no-flag Native row", () => {
    const psuValues = (SU_CONTEXT_CHOICES as Array<{ value: string | null }>)
      .map((c) => c.value)
      .filter((v): v is string => v !== null);
    expect([...SU_CONTEXT_SIZES]).toEqual(psuValues);
  });

  it("the token estimates shown beside each variant match psu's own", () => {
    for (const size of SU_CONTEXT_SIZES) {
      expect(SU_CONTEXT_TOKEN_ESTIMATES[size], size).toBe(
        (PSU_SU_CONTEXT_TOKEN_ESTIMATES as Record<string, string>)[size],
      );
    }
  });

  it("the GUI default matches psu's picker default — the same launch either way", () => {
    expect(SU_CONTEXT_DEFAULT).toBe(PSU_SU_CONTEXT_DEFAULT);
  });

  it("composeLaunchModelSpec produces specs psu itself accepts, for every model×effort", () => {
    for (const row of CLOUD_MODEL_MENU) {
      for (const effort of MODEL_EFFORT_LEVELS) {
        const spec = composeLaunchModelSpec(row.value, effort)!;
        expect(spec, `${row.value}:${effort}`).toBe(`${row.value}:${effort}`);
        expect(validateModelSpec(spec).ok, spec).toBe(true);
      }
    }
  });

  it("REFUSES an effort with no model instead of silently dropping it (the GUI bug)", () => {
    // The old private copy in NewSessionLauncher returned the (empty) model and
    // discarded the effort, so a human who picked "xhigh" got the backend default
    // and was never told. psu has no standalone effort flag — there is nowhere for
    // it to go, so this must be an error, not a quiet no-op.
    expect(() => composeLaunchModelSpec("", "xhigh")).toThrow(/needs a model/);
    expect(() => composeLaunchModelSpec(undefined, "max")).toThrow(
      /needs a model/,
    );
  });

  it("replaces an effort tail already on the spec rather than doubling it", () => {
    expect(composeLaunchModelSpec("fable:low", "max")).toBe("fable:max");
  });

  it('leaves a non-effort colon suffix alone (bedrock ids end in ":0")', () => {
    // Non-vacuity guard on the peel: ':0' is part of the model id, not an effort.
    expect(composeLaunchModelSpec("anthropic.claude-v2:0", "high")).toBe(
      "anthropic.claude-v2:0:high",
    );
  });

  it("an unrecognized effort is refused, naming what psu accepts", () => {
    expect(() => composeLaunchModelSpec("fable", "turbo")).toThrow(
      /low\|medium\|high\|xhigh\|max/,
    );
  });
});

describe("resumeModelMenuFor — the resume menu is scoped to the session backend (WI-4891)", () => {
  it("a claude session is offered ONLY claude-family models (never sol/luna/terra)", () => {
    const values = resumeModelMenuFor("claude").map((c) => c.value);
    expect(values).toEqual(["opus", "sonnet", "fable", "haiku"]);
    for (const v of values) expect(cloudModelBackendHint(v), v).toBe("claude");
  });
  it("a codex session is offered ONLY codex-family models (never opus/sonnet/…)", () => {
    const values = resumeModelMenuFor("codex").map((c) => c.value);
    expect(values).toEqual(["sol", "luna", "terra"]);
    for (const v of values) expect(cloudModelBackendHint(v), v).toBe("codex");
  });
  it("an omp session gets an EMPTY menu (falls through to the free-text spec — omp vocabulary is open)", () => {
    expect(resumeModelMenuFor("omp")).toEqual([]);
  });
  it("the crux: every offered row PAIRS with the session backend — no cross-backend model is ever offered", () => {
    for (const agent of ["claude", "codex", "omp"] as const) {
      for (const row of resumeModelMenuFor(agent)) {
        // validateAgentModelPair is exactly the guard resumeArgsFor's launch would hit.
        expect(
          validateAgentModelPair(agent, row.value).ok,
          `${agent} ⟵ ${row.value}`,
        ).toBe(true);
      }
    }
  });
  it("rows are stripped to the inquirer {name,value} shape (no leaked backend tag)", () => {
    for (const row of resumeModelMenuFor("claude")) {
      expect(Object.keys(row).sort()).toEqual(["name", "value"]);
    }
  });
});

describe("cross-backend resume target + protocol-v1 launcher contract", () => {
  const source = {
    id: 42,
    sessionId: "bb06937a-2054-4f27-945b-225b84dc3ccb",
    agent: "claude",
    role: null,
    workspaceId: "papercusp-workspace",
    coordOwnerId: "su-source-owner",
    cwd: "/repo",
    planSlug: "the-plan",
  };

  it("keeps same-backend selections on the native path byte-for-byte", () => {
    expect(
      resolveResumeTarget(source, { agent: "claude", model: "opus[1m]:high" }),
    ).toEqual({
      operation: "native",
      sourceAgent: "claude",
      targetAgent: "claude",
      provider: "anthropic",
      modelSpec: "opus[1m]:high",
    });
  });

  // R-12 / R-14 (consult-expert-routing-2026-09-22, D-005). THE REGRESSION TEST ON
  // THE CONVERSION PATH, and the only one that can exist: the defect lived in the
  // SEAM. operator-core composes the argv and apps/operator parses it, so each side
  // was internally consistent and neither side's suite could see the loss — psu's
  // own resolver tests above pass `{ agent: "codex" }` as a plain object and never
  // ask where that field comes from on a scripted launch.
  //
  // MEASURED before the fix, by round-tripping the composed argv through parseArgs:
  // buildAgentLaunchCommand omitted --agent on every resume, so psu back-filled the
  // backend from cloudModelBackendHint(model) alone. That hint is null for an OMP
  // target (open-set vocabulary, by design), for any unrecognized model id, and for
  // a conversion naming no model — and resolveResumeTarget then falls through to
  // sourceAgent. Three of these four cases resolved to operation:"native" on claude,
  // silently, while the caller believed it had asked for a conversion. Only the
  // named-codex-model case worked, and only by accident of the model name.
  it.each([
    { label: "omp, no model", core: { targetAgent: "omp" }, targetAgent: "omp" },
    {
      label: "omp, open-set model the hint can never classify",
      core: { targetAgent: "omp", model: "papercusp-gateway/llama-3" },
      targetAgent: "omp",
    },
    {
      label: "codex via the deliberately-selected configured default",
      core: { targetAgent: "codex", modelSource: "configured-default" as const },
      targetAgent: "codex",
    },
    {
      label: "codex, explicitly named model",
      core: { targetAgent: "codex", model: "gpt-5.6-sol:xhigh" },
      targetAgent: "codex",
    },
  ])(
    "round-trips a cross-backend resume through the composed argv: $label",
    ({ core, targetAgent }) => {
      const command = buildAgentLaunchCommand({
        mode: "resume",
        resumeId: String(source.id),
        agent: source.agent,
        headless: true,
        ...core,
      });
      // psu's OWN parser over the shared core's OWN output — no hand-written argv,
      // because a hand-written one is exactly what hid this for as long as it did.
      const parsed = parseArgs(command.split(" ").slice(1));
      expect(parsed.agent).toBe(targetAgent);
      expect(resolveResumeTarget(source, parsed)).toMatchObject({
        operation: "port",
        sourceAgent: "claude",
        targetAgent,
      });
    },
  );

  // Every-pair picker + port resolution for codex/omp sources lives in
  // psu-resume-cross-backend.test.ts (acceptance bar R-10's tree check).
  it("CONTROL: a resume that names no target still composes a same-backend native resume", () => {
    const command = buildAgentLaunchCommand({
      mode: "resume",
      resumeId: String(source.id),
      agent: source.agent,
      model: "opus[1m]:high",
    });
    expect(command).not.toContain("--agent");
    // parseArgs consumes argv, after the shell has removed quotes around the model.
    const argv = command.split(" ").slice(1).map(arg => arg.replace(/^--model='([^']+)'$/, "--model=$1"));
    const parsed = parseArgs(argv);
    expect(parsed.model).toBe("opus[1m]:high");
    expect(resolveResumeTarget(source, parsed)).toMatchObject({
      operation: "native",
      targetAgent: "claude",
    });
  });

  it("infers Codex from a cloud model alias and makes the operation an explicit port", () => {
    expect(resolveResumeTarget(source, { model: "sol:xhigh" })).toMatchObject({
      operation: "port",
      sourceAgent: "claude",
      targetAgent: "codex",
      provider: "openai",
      modelSpec: "gpt-5.6-sol:xhigh",
      modelSource: "explicit",
    });
  });

  it.each(["headless", "no-picker"])("round-trips a model-less %s Codex resume into recorded model inheritance", (placement) => {
    const recorded = {
      ...source,
      agent: "codex",
      launchArgv: ["psu", "--agent=codex", "--model=gpt-6.1-sol:high"],
    };
    const command = buildAgentLaunchCommand({
      mode: "resume",
      resumeId: String(recorded.id),
      agent: "codex",
      targetAgent: "codex",
      headless: placement === "headless",
    });
    const argv = command.split(" ").slice(1);
    if (placement === "no-picker") argv.push("--no-picker");
    const parsed = parseArgs(argv);
    expect(parsed.model).toBeNull();
    expect(resolveResumeTarget(recorded, parsed)).toMatchObject({
      operation: "native",
      modelSpec: "gpt-6.1-sol:high",
      modelSource: "inherited",
    });
    expect(() => resolveResumeTarget({ ...recorded, launchArgv: null }, parsed)).toThrow(/Codex model is required/);
  });

  it("inherits a recorded Codex model for unattended native resume and rejects unresolved history", () => {
    const recorded = {
      ...source,
      agent: "codex",
      launchArgv: [
        "psu",
        "--no-picker",
        "--agent=codex",
        "--headless",
        "--model=gpt-5.6-terra:high",
        "--model-source=explicit",
      ],
    };
    expect(resolveResumeTarget(recorded, { picker: false })).toMatchObject({
      operation: "native",
      modelSpec: "gpt-5.6-terra:high",
      modelSource: "inherited",
    });
    expect(() =>
      resolveResumeTarget({ ...recorded, launchArgv: null }, { picker: false }),
    ).toThrow(/Codex model is required/);
    expect(() =>
      resolveResumeTarget(
        { ...recorded, launchArgv: ["psu", "--agent=codex", "--model=gpt-5.3-codex-spark"] },
        { picker: false },
      ),
    ).toThrow(/denied/i);
  });

  it("inherits the transcript model for an older tracked Codex row with no launch argv", () => {
    const recorded = {
      ...source,
      agent: "codex",
      launchArgv: null,
    };
    const selection = resumeTargetSelectionFromLastActive(
      recorded,
      { picker: false },
      "gpt-5.6-sol",
    );
    expect(selection).toEqual({
      targetAgent: "codex",
      modelSpec: "gpt-5.6-sol",
      modelSource: "inherited",
    });
    expect(resolveResumeTarget(recorded, { picker: false }, selection)).toMatchObject({
      operation: "native",
      modelSpec: "gpt-5.6-sol",
      modelSource: "inherited",
    });
  });

  it.each(
    ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]
      .flatMap((model) => ["low", "medium", "high", "xhigh", "max"]
        .map((effort) => ({ model, effort }))),
  )("scripted Codex resume keeps the complete $model:$effort turn selection", ({ model, effort }) => {
    const recorded = {
      ...source,
      agent: "codex",
      launchArgv: ["psu", "--agent=codex", "--model=gpt-5.6-sol:medium"],
    };
    const selected = resumeTargetSelectionFromLastActive(
      recorded, { picker: false }, `${model}:${effort}`,
    );
    expect(resolveResumeTarget(recorded, { picker: false }, selected)).toMatchObject({
      operation: "native", modelSpec: `${model}:${effort}`, modelSource: "inherited",
    });
  });

  it("wires transcript-derived Codex selection into scripted/no-picker resumes", () => {
    const sourceText = readFileSync(
      join(__dirname, "..", "scripts", "psu-launcher.mjs"),
      "utf8",
    );
    const body = sourceText.slice(
      sourceText.indexOf("async function chooseResumeTarget("),
    );
    expect(body).toContain("resumeTargetSelectionFromLastActive(");
    expect(body).toContain(
      "resolveResumeTarget(session, args, transcriptSelection)",
    );
  });

  it("treats a visible backend-default choice as deliberate configured-default authorization", () => {
    expect(
      resolveResumeTarget(
        { ...source, agent: "codex", launchArgv: null },
        { picker: true },
        { targetAgent: "codex", modelSpec: null },
      ),
    ).toMatchObject({
      modelSpec: CODEX_SAFE_DEFAULT_MODEL,
      modelSource: "configured-default",
    });
  });

  it.each([
    {
      name: "configured default",
      args: { picker: true },
      selected: { targetAgent: "codex", modelSpec: null },
      expectedModel: CODEX_SAFE_DEFAULT_MODEL,
      expectedSource: "configured-default",
    },
    {
      name: "provider-prefixed explicit model",
      args: {
        picker: false,
        agent: "codex",
        model: "openai/gpt-5.6-sol:xhigh",
        modelSource: "explicit",
      },
      selected: {},
      expectedModel: "gpt-5.6-sol:xhigh",
      expectedSource: "explicit",
    },
  ])(
    "keeps a Claude-to-Codex $name identical from preview through bootstrap",
    ({ args, selected, expectedModel, expectedSource }) => {
      // Owner reproduction, 2026-09-05: the picker deliberately selected the
      // Codex backend default, but resolveResumeTarget left the prepared row's
      // target_model NULL. bootstrap-su independently resolved that NULL to the
      // managed Codex default and then rejected its own preparation as a target
      // mismatch. The provider-prefixed spelling is the second drift-prone form:
      // it must be canonicalized once and stay byte-identical after that. Exercise
      // the whole launcher-side contract in one table so selection/request/
      // bootstrap helpers cannot drift while passing separately.
      const target = resolveResumeTarget(source, args, selected);
      const request = sessionPortRequestBody(source, target, {}, args);
      const targetArgs = sessionPortTargetArgs(
        source,
        target,
        {},
        { ...args, addDir: [], passthrough: [] },
        { token: `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}` },
      );
      const bootstrap = freshSuBootstrapBody(
        {
          agent: target.targetAgent,
          workspace: source.workspaceId,
          harness: null,
          plan: source.planSlug,
        },
        targetArgs,
      );

      expect(target).toMatchObject({
        operation: "port",
        targetAgent: "codex",
        modelSpec: expectedModel,
        modelSource: expectedSource,
      });
      expect(request.targetModel).toBe(target.modelSpec);
      expect(bootstrap.model).toBe(request.targetModel);
      expect(bootstrap.model_source).toBe(expectedSource);
      expect(bootstrap.session_port_token).toBe(targetArgs.sessionPortToken);
    },
  );

  it("requires an explicit OMP backend for its open model vocabulary", () => {
    expect(
      resolveResumeTarget(source, { agent: "omp", model: "local/qwen3:high" }),
    ).toMatchObject({
      operation: "port",
      targetAgent: "omp",
      provider: "omp-configured-provider",
    });
    expect(
      resolveResumeTarget(source, {
        agent: "omp",
        model: "anthropic/claude-opus-4-6",
      }),
    ).toMatchObject({ modelSpec: "anthropic/claude-opus-4-6" });
  });

  it("refuses authority-ambiguous operations and unsupported source directions", () => {
    expect(() =>
      resolveResumeTarget(source, { agent: "codex", fork: true }),
    ).toThrow(/cannot be combined/);
    expect(
      resolveResumeTarget({ ...source, agent: "codex" }, { agent: "claude" }),
    ).toMatchObject({ operation: "port", targetAgent: "claude" });
    expect(() =>
      resolveResumeTarget(source, { agent: "codex", model: "opus" }),
    ).toThrow(/belongs to/);
  });

  it("builds a target-scoped request only from tracked source identity", () => {
    const target = resolveResumeTarget(source, {
      agent: "codex",
      model: "sol:high",
    });
    expect(sessionPortTargetAccount({ forward: "auto" })).toBe("auto");
    expect(sessionPortTargetAccount({ id: "acct-openai" })).toBe("acct-openai");
    expect(sessionPortTargetAccount({ notice: "fallback" })).toBe("default");
    expect(
      sessionPortRequestBody(
        source,
        target,
        { id: "acct-openai" },
        { contextSize: "trimmed", launchContext: "/brief.md" },
      ),
    ).toEqual({
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      transformVersion: SESSION_PORT_TRANSFORM_VERSION,
      workspace: "papercusp-workspace",
      sourceAdvSessionId: 42,
      sourceNativeSessionId: source.sessionId,
      targetBackend: "codex",
      targetModel: "gpt-5.6-sol:high",
      targetAccount: "acct-openai",
      contextSize: "trimmed",
      launchContext: "/brief.md",
      currentInstruction: null,
    });
    expect(
      sessionPortRequestBody(source, target, { id: "acct-openai" }, {
        picker: false,
        kickoffPromptText: "continue\r\nnow",
      }).currentInstruction,
    ).toBe("continue\r\nnow");
    expect(() =>
      sessionPortRequestBody({ ...source, coordOwnerId: null }, target, {}, {}),
    ).toThrow(/coordination identity/);
    expect(() =>
      sessionPortRequestBody({ ...source, id: null }, target, {}, {}),
    ).toThrow(/tracked source/);
  });

  it("binds a port to the requested earlier incarnation instead of its tracking row's current session", () => {
    const earlier = "2d90f85e-90f0-4d92-8a5e-2a9154dbd9fb";
    const selected = rehydrateOutOfWindowTrackedSession(
      { id: source.id, psuTracked: true, sessionId: earlier },
      { sessions: [source] },
    );
    expect(selected).not.toBeNull();
    const request = sessionPortRequestBody(selected, resolveResumeTarget(selected, { agent: "codex" }), {}, {});
    expect(request).toMatchObject({ sourceAdvSessionId: source.id, sourceNativeSessionId: earlier });
  });

  it("uses the tracked OMP thread id for the exact port source", () => {
    const selected = { ...source, agent: "omp", ompThreadId: "exact-omp-thread", sessionId: null };
    expect(sessionPortRequestBody(selected, resolveResumeTarget(selected, { agent: "codex" }), {}, {}))
      .toMatchObject({ sourceNativeSessionId: "exact-omp-thread" });
  });

  it("selects isolated ports for the complete backend matrix and preserves ordinary native resume", () => {
    for (const sourceAgent of ['claude', 'codex', 'omp']) {
      for (const targetAgent of ['claude', 'codex', 'omp']) {
        const nativeSource = { ...source, agent: sourceAgent };
        const args = { agent: targetAgent, model: targetAgent === 'codex' ? 'sol:high' : 'opus', ownerId: 'su-answer-owner', launchedBy: 'su-requester' };
        const resolved = resolveResumeTarget(nativeSource, args);
        expect(resolved).toMatchObject({ operation: 'port', targetAgent });
        expect(sessionPortRequestBody(nativeSource, resolved, {}, args)).toMatchObject({ targetOwnerId: 'su-answer-owner' });
        expect(sessionPortTargetArgs(nativeSource, resolved, {}, args, { portId: 'p', token: 'p.token' }))
          .toMatchObject({ ownerId: 'su-answer-owner', launchedBy: 'su-requester', fork: false, resume: false });
        expect(nativeSource.coordOwnerId).toBe(source.coordOwnerId);
      }
      expect(resolveResumeTarget({ ...source, agent: sourceAgent }, {
        agent: sourceAgent, model: sourceAgent === 'codex' ? 'sol:high' : 'opus',
      })).toMatchObject({ operation: 'native' });
    }
  });

  it("carries the consult evidence-span selection into the session-port inspection request", () => {
    const previous = process.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN;
    process.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN = JSON.stringify({
      sessionId: source.sessionId,
      turnIndices: [2, 4],
      contextTurns: 2,
    });
    try {
      const request = sessionPortRequestBody(
        source,
        resolveResumeTarget(source, { agent: "codex", model: "sol:high" }),
        {},
        {},
      );
      expect(request.consultEvidenceSpan).toEqual({
        sessionId: source.sessionId,
        turnIndices: [2, 4],
        contextTurns: 2,
      });
      expect(process.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN;
      else process.env.PAPERCUSP_CONSULT_EVIDENCE_SPAN = previous;
    }
  });

  it("keeps the seed as a scripted port's ONLY first turn — no plain kickoff reaches the PTY host (WI-10003858)", () => {
    // Live failure 2026-09-29: consult-dispatch launches every convert with the
    // brief in PAPERCUSP_KICKOFF_PROMPT. The port folds it into the seed as
    // currentInstruction, but the fresh target re-read the same env as a plain
    // kickoff, and psu-pty-host refuses kickoff + kickoffFile together — so every
    // grader convert exited 1 in <0.4s before its session existed.
    const BRIEF = "Answer consult conv-x: grade the acceptance rubric.";
    const provenanceDir = mkdtempSync(join(tmpdir(), "su-port-kickoff-prov-"));
    const env = {
      PAPERCUSP_KICKOFF_PROMPT: BRIEF,
      PAPERCUSP_TURN_PROVENANCE_DIR: provenanceDir,
    };
    const previous = process.env.PAPERCUSP_KICKOFF_PROMPT;
    try {
      process.env.PAPERCUSP_KICKOFF_PROMPT = BRIEF;
      for (const scripted of [
        parseArgs(["--no-picker", "--agent=codex", "--model=sol:high"]),
        parseArgs([
          "--no-picker",
          "--agent=codex",
          "--model=sol:high",
          `--kickoff=${BRIEF}`,
        ]),
      ]) {
        const target = resolveResumeTarget(source, scripted);
        // The instruction still reaches the target — through the seed.
        expect(
          sessionPortRequestBody(source, target, {}, scripted).currentInstruction,
        ).toBe(BRIEF);
        // Control: the caller's untransformed args DO resolve a plain kickoff, so
        // the assertion below is not passing on a dead env or a missing flag.
        expect(
          finalizeFreshSuArgs("codex", [], { kickoffPrompt: null }, scripted, env)
            .kickoffSeeded,
        ).toBe(true);
        const targetArgs = sessionPortTargetArgs(
          source,
          target,
          {},
          { ...scripted, addDir: [], passthrough: [] },
          { token: `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}` },
        );
        const fresh = finalizeFreshSuArgs(
          "codex",
          [],
          { kickoffPrompt: null },
          targetArgs,
          env,
        );
        expect(fresh.kickoff).toBeNull();
        expect(fresh.kickoffSeeded).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_KICKOFF_PROMPT;
      else process.env.PAPERCUSP_KICKOFF_PROMPT = previous;
      rmSync(provenanceDir, { recursive: true, force: true });
    }
  });

  it("records resume provenance and forwards the opaque handshake/source cwd to bootstrap", () => {
    const args = sessionPortTargetArgs(
      source,
      resolveResumeTarget(source, { agent: "codex", model: "sol:high" }),
      { id: "acct-openai" },
      { model: "sol:high", account: "default", addDir: [], passthrough: [] },
      { token: `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}` },
    );
    expect(args).toMatchObject({
      ownerId: "su-source-owner",
      account: "acct-openai",
      modelSource: "explicit",
      sessionPortTransformVersion: SESSION_PORT_TRANSFORM_VERSION,
      sessionPortSourceAdvSessionId: 42,
      sessionPortSourceCwd: "/repo",
    });
    const body = freshSuBootstrapBody(
      {
        agent: "codex",
        workspace: "papercusp-workspace",
        harness: null,
        plan: "the-plan",
      },
      args,
    );
    expect(body.cwd).toBe("/repo");
    expect(body.session_port_protocol).toBe(SESSION_PORT_PROTOCOL_VERSION);
    expect(body.session_port_transform_version).toBe(SESSION_PORT_TRANSFORM_VERSION);
    expect(body.session_port_token).toBe(args.sessionPortToken);
    expect(body.bootstrap_idempotency_key).toBe(
      "session-port:22222222-2222-4222-8222-222222222222",
    );
    expect(body.owner_id).toBe("su-source-owner");
    expect(body.launch_argv).toContain("--resume=42");
    expect(body.launch_argv).toContain("--agent=codex");
  });

  it("maps new-launcher/old-server skew to one actionable upgrade error", () => {
    expect(
      sessionPortUpgradeError(
        Object.assign(new Error("not found"), { status: 404 }),
      ).message,
    ).toMatch(/Upgrade.*operator together/i);
    expect(
      sessionPortUpgradeError(
        Object.assign(new Error("unsupported session-port protocol"), {
          status: 426,
        }),
      ).message,
    ).toMatch(/migration 611/i);
    expect(sessionPortUpgradeError(new Error("ordinary failure")).message).toBe(
      "ordinary failure",
    );
  });

  it("renders the inspect-before-egress disclosure with omissions and authority boundary", () => {
    const lines = formatSessionPortInspection({
      inspection: {
        source: {
          advSessionId: 42,
          backend: "claude",
          snapshotKind: "live-jsonl",
          completeBytes: 100,
          sha256: "a".repeat(64),
        },
        target: { backend: "codex", model: "sol", availableInputTokens: 1000 },
        fullHistoryEstimatedTokens: 1800,
        fullPayloadEstimatedTokens: 2000,
        tokenEstimator: "utf8-byte-upper-bound-v1",
        requiresSummary: true,
        stats: {
          redactions: 2,
          omittedThinkingBlocks: 1,
          omittedSignatureBlocks: 1,
          omittedAttachments: 1,
          textAttachments: 2,
          truncatedAttachments: 1,
          unsupportedBlocks: 3,
          sidechainRecords: 4,
        },
        disclosure: {
          authorityCarried: true,
          targetEgress: "openai/default",
          summarizerEgress: "papercusp inference gateway",
        },
        warnings: ["one malformed record"],
      },
    });
    expect(lines.join("\n")).toMatch(/summary \+ recent tail/);
    expect(lines.join("\n")).toMatch(/preserving the source coordination identity/);
    expect(lines.join("\n")).toMatch(/one malformed record/);
  });

  describe("session-port inspection backend and authority disclosure", () => {
    it.each([
      ["claude", "Claude"],
      ["codex", "Codex"],
      ["omp", "OMP"],
    ])("labels the actual %s source backend", (backend, label) => {
      const lines = formatSessionPortInspection({
        inspection: {
          source: { backend, advSessionId: 42 },
          target: { backend: "codex", model: "sol" },
          disclosure: { authorityCarried: true },
        },
      });
      expect(lines[0]).toBe(
        `psu: cross-backend port preview — ${label} session #42 → codex/sol`,
      );
      expect(lines.join("\n")).toMatch(/preserving the source coordination identity/);
    });

    it.each(["claude", "codex", "omp"])(
      "discloses a distinct answering owner for a %s source",
      (backend) => {
        const lines = formatSessionPortInspection({
          inspection: {
            source: { backend, advSessionId: 42 },
            target: { backend: "codex", ownerId: "su-isolated-answer" },
            disclosure: { authorityCarried: false },
          },
        });
        const authority = lines.find((line) => line.startsWith("psu: isolation"));
        expect(authority).toContain("su-isolated-answer");
        expect(authority).toContain("source authority (fleet/loop/claims/modes/awaits/locks) is not carried to the target");
        expect(lines.join("\n")).not.toMatch(/preserving the source coordination identity|continue on the target/);
      },
    );

    it("keeps missing backend and authority declarations explicit", () => {
      const lines = formatSessionPortInspection({
        inspection: { source: { advSessionId: 42 }, target: { backend: "codex" } },
      });
      expect(lines[0]).toContain("unknown session #42");
      expect(lines.join("\n")).toContain("coordination identity continuity is unknown");
      expect(lines.join("\n")).not.toContain("preserving the source coordination identity");
    });

    it("reports absent inspection", () => {
      expect(formatSessionPortInspection({})).toEqual([
        "psu: session-port inspection unavailable",
      ]);
    });
  });

  it("reconciles a lost delivery response against the durable status route", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            port: { status: "delivered", targetAdvSessionId: 99 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const result = await reportSessionPortDelivery(
      {
        protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
        transformVersion: SESSION_PORT_TRANSFORM_VERSION,
        portId: "22222222-2222-4222-8222-222222222222",
        targetAdvSessionId: 99,
        workspace: "papercusp-workspace",
      },
      {
        persisted: true,
        renderedHash: "a".repeat(64),
        nativeRef: "/native/rollout.jsonl",
      },
      { fetchImpl, operatorUrl: "http://operator", token: "token" },
    );
    expect(result.port.status).toBe("delivered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      transformVersion: SESSION_PORT_TRANSFORM_VERSION,
    });
  });

  it.each([
    ["pending", { status: "pending", targetAdvSessionId: 99 }, "session_port_ack_outcome_unknown"],
    ["missing status", { targetAdvSessionId: 99 }, "session_port_ack_outcome_unknown"],
    ["missing target", { status: "delivered" }, "session_port_ack_outcome_unknown"],
    ["wrong target", { status: "delivered", targetAdvSessionId: 100 }, "session_port_ack_refused"],
    ["wrong port", { id: "33333333-3333-4333-8333-333333333333", status: "delivered", targetAdvSessionId: 99 }, "session_port_ack_refused"],
    ["terminal failure", { status: "failed", targetAdvSessionId: 99 }, "session_port_ack_refused"],
  ])("EI-259750: preserves typed %s acknowledgement receipts without accepting delivery", async (_label, port, code) => {
    const appendEventImpl = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "upstream reset SECRET-PAYLOAD", forwardingResult: "outcome_unknown" }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, port }), { status: 200 }));
    const failure = await reportSessionPortDelivery(
      { portId: "22222222-2222-4222-8222-222222222222", targetAdvSessionId: 99, workspace: "test" },
      { persisted: true, renderedHash: "a".repeat(64), nativeRef: "/native/SECRET-PATH.jsonl" },
      { fetchImpl, operatorUrl: "http://operator", token: "SECRET-TOKEN", coordOwnerId: "su-test", appendEventImpl },
    ).catch((error) => error);
    expect(failure.code).toBe(code);
    expect(failure.acknowledgement.receipts).toHaveLength(2);
    expect(failure.acknowledgement.receipts[0]).toMatchObject({ stage: "delivery", httpStatus: 502, forwardingResult: "outcome_unknown" });
    expect(failure.acknowledgement.receipts[1]).toMatchObject({ stage: "status", httpStatus: 200 });
    expect(fetchImpl.mock.calls.map((call) => call[1].method)).toEqual(["POST", "GET"]);
    expect(appendEventImpl).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      expect(fetchImpl.mock.calls[i][1].headers["x-papercusp-mcp-trace-id"]).toBe(failure.acknowledgement.receipts[i].traceId);
      expect(appendEventImpl.mock.calls[i][2]).toMatchObject({ portId: "22222222-2222-4222-8222-222222222222", expectedTargetAdvSessionId: 99, stage: i === 0 ? "delivery" : "status" });
    }
    expect(JSON.stringify(appendEventImpl.mock.calls)).not.toContain("SECRET");
  });

  it("EI-259750: records an invalid JSON status body as unknown rather than swallowing the receipt", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(new Response("not JSON", { status: 200 }));
    const error = await reportSessionPortDelivery(
      { portId: "22222222-2222-4222-8222-222222222222", targetAdvSessionId: 99 },
      { persisted: true, renderedHash: "a".repeat(64), nativeRef: "/native/rollout.jsonl" },
      { fetchImpl, operatorUrl: "http://operator", token: "token" },
    ).catch((failure) => failure);
    expect(error.code).toBe("session_port_ack_outcome_unknown");
    expect(error.acknowledgement.receipts[1]).toMatchObject({ stage: "status", httpStatus: 200, errorName: "SyntaxError" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("token-finalizes a prepared port when target bootstrap never minted a row", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            port: {
              id: "22222222-2222-4222-8222-222222222222",
              status: "prepared",
              targetAdvSessionId: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            status: "failed",
            targetAdvSessionId: null,
            artifactDeleted: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const result = await reportSessionPortLaunchFailure(
      {
        protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
        transformVersion: SESSION_PORT_TRANSFORM_VERSION,
        workspace: "papercusp-workspace",
        portId: "22222222-2222-4222-8222-222222222222",
        token: `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}`,
      },
      new Error("prepared target does not match bootstrap target"),
      { fetchImpl, operatorUrl: "http://operator", token: "token" },
    );
    expect(result).toMatchObject({
      status: "failed",
      targetAdvSessionId: null,
      artifactDeleted: true,
    });
    const disposition = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(disposition).toMatchObject({
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      transformVersion: SESSION_PORT_TRANSFORM_VERSION,
      status: "failed",
      portId: "22222222-2222-4222-8222-222222222222",
      preparationToken: `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}`,
    });
    expect(disposition).not.toHaveProperty("targetAdvSessionId");
    expect(disposition.error).toMatch(/target bootstrap\/spawn failed.*does not match/s);
  });

  it("finalizes a post-prepare bootstrap failure before surfacing its stage and cause", async () => {
    const target = resolveResumeTarget(
      source,
      { picker: true },
      { targetAgent: "codex", modelSpec: null },
    );
    const sessionPortApiImpl = vi
      .fn()
      .mockResolvedValueOnce({
        inspection: { source: { nativeSessionId: source.sessionId, sha256: "a".repeat(64) } },
      })
      .mockResolvedValueOnce({
        portId: "22222222-2222-4222-8222-222222222222",
        token: `22222222-2222-4222-8222-222222222222.${"a".repeat(64)}`,
        fidelity: "full",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    const launchFailure = new Error(
      "prepared target codex/default does not match bootstrap codex/gpt-5.6-sol:xhigh",
    );
    const reportLaunchFailureImpl = vi.fn(async () => ({
      status: "failed",
      artifactDeleted: true,
    }));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        launchSessionPort(
          source,
          target,
          {},
          { picker: false, addDir: [], passthrough: [] },
          {
            sessionPortApiImpl,
            launchFreshSuImpl: vi.fn(async () => {
              throw launchFailure;
            }),
            reportLaunchFailureImpl,
          },
        ),
      ).rejects.toThrow(/was finalized failed.*prepared target codex\/default/s);
    } finally {
      stderr.mockRestore();
    }
    expect(reportLaunchFailureImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        portId: "22222222-2222-4222-8222-222222222222",
        protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
        transformVersion: SESSION_PORT_TRANSFORM_VERSION,
        workspace: "papercusp-workspace",
      }),
      launchFailure,
    );
  });

  it.each(["another-native-session", undefined])("refuses substituted or missing inspected native session %s before preparation", async (nativeSessionId) => {
    const sessionPortApiImpl = vi.fn(async () => ({ inspection: { source: { nativeSessionId } } }));
    const launchFreshSuImpl = vi.fn();
    await expect(launchSessionPort(source, resolveResumeTarget(source, { agent: "codex" }), {},
      { picker: false }, { sessionPortApiImpl, launchFreshSuImpl }))
      .rejects.toThrow(/did not preserve the selected native session.*upgrade/);
    expect(sessionPortApiImpl).toHaveBeenCalledTimes(1);
    expect(launchFreshSuImpl).not.toHaveBeenCalled();
  });

  it("converts only session-port preflight exits into finalizable exceptions", () => {
    expect(
      sessionPortLaunchAbortError(
        { sessionPortToken: "opaque" },
        new Error("persona missing"),
        "launch preflight",
      ),
    ).toMatchObject({
      message:
        "session-port target launch preflight failed after preparation: persona missing",
      cause: expect.any(Error),
    });
    expect(
      sessionPortLaunchAbortError(
        { sessionPortToken: null },
        new Error("ordinary launch"),
        "launch preflight",
      ),
    ).toBeNull();
  });
});

describe("nativeCompactionEnv (P-022 — native auto-compact retired for every Claude launch)", () => {
  it("claude → DISABLE_AUTO_COMPACT + DISABLE_COMPACT regardless of spec or window (the carry-respawn ladder owns the boundary; the /compact command itself is removed)", () => {
    expect(nativeCompactionEnv("claude")).toEqual({
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
    });
  });

  it("non-claude agents get no env fragment — their compaction is papercusp-owned at their own launch legs", () => {
    expect(nativeCompactionEnv("omp")).toEqual({});
    expect(nativeCompactionEnv("codex")).toEqual({});
    expect(nativeCompactionEnv(null)).toEqual({});
    expect(nativeCompactionEnv(undefined)).toEqual({});
  });
});

describe("validateModelSpec + --model guard (WI-1979 — reject a malformed model spec at parse)", () => {
  it("accepts valid aliases, effort specs, full/provider ids, [1m] round-trips, and local ids", () => {
    for (const s of [
      "fable:xhigh",
      "opus:max",
      "sonnet",
      "sonnet:high",
      "haiku",
      "opus[1m]:max",
      "sonnet[1m]",
      "claude-fable-5:xhigh",
      "claude-fable-5[1m]",
      "claude-sonnet-5:high",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "sol",
      "sol:high",
      "sol:max",
      "terra:xhigh",
      "luna",
      "luna:medium",
      "gpt-5.6-sol",
      "gpt-5.6-terra:high",
      "gpt-5.6-luna:xhigh",
      "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
      "gpt-5-codex",
      "",
    ]) {
      expect(validateModelSpec(s).ok, s).toBe(true);
    }
  });
  it("accepts an unknown-but-plausible short id that is NOT a close typo (o3 / gpt4 / grok)", () => {
    for (const s of ["o3", "gpt4", "grok"])
      expect(validateModelSpec(s).ok, s).toBe(true);
  });
  it("rejects a hand-typed [1m] marker on a non-family base (the fabel5[1m] incident), with the marker tip + suggestion", () => {
    const r = validateModelSpec("fabel5[1m]");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("do not type it"); // the "[1m] is auto-appended" tip
    expect(r.message).toContain("fable"); // corrective suggestion (Damerau catches the transposition)
  });
  it('rejects a close-typo alias — incl. transpositions — with a "did you mean" suggestion', () => {
    for (const [bad, want] of [
      ["fabel", "fable"],
      ["sonet", "sonnet"],
      ["sonnet5", "sonnet"],
      ["opus4", "opus"],
      ["opuss", "opus"],
      ["fabel5:xhigh", "fable"],
    ] as const) {
      const r = validateModelSpec(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.message, bad).toContain(want);
    }
  });
  it("rejects the alias-glued-to-version shorthand (sonnet-5 / opus-4.8 / haiku-4 / sol-5.6) — the common leak that reached the CLI as an unrunnable id", () => {
    for (const [bad, want] of [
      ["sonnet-5", "sonnet"],
      ["sonnet-5:high", "sonnet:high"],
      ["opus-4.8", "opus"],
      ["haiku-4", "haiku"],
      ["fable-5:xhigh", "fable:xhigh"],
      ["opus-4-8", "opus"],
      ["sonnet5", "sonnet"],
      ["sol-5.6", "sol"],
      ["terra-5", "terra"],
      ["luna-5.6", "luna"],
      ["sol-5.6:high", "sol:high"],
    ] as const) {
      const r = validateModelSpec(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.message, bad).toContain(want);
    }
  });
  it("keeps genuine full/versioned ids valid (claude-<fam>-<ver>) — the vendor prefix distinguishes them from the bare-alias shorthand", () => {
    for (const s of [
      "claude-sonnet-5",
      "claude-sonnet-5:high",
      "claude-opus-4-8",
      "claude-fable-5[1m]",
    ]) {
      expect(validateModelSpec(s).ok, s).toBe(true);
    }
  });
  it("parseArgs THROWS the corrective error for --model=fabel5[1m] (covers every launch path)", () => {
    expect(() => parseArgs(["--model=fabel5[1m]"])).toThrow(/fable/);
  });
  it("parseArgs is a no-op on VALID input — a good --model spec still normalizes", () => {
    expect(parseArgs(["--model=fable:xhigh"]).model).toBe("fable[1m]:xhigh");
    expect(parseArgs(["--model=opus:max"]).model).toBe("opus[1m]:max");
  });
});

describe("validateModelSpec ⟷ validateCloudModelSpec PARITY (WI-1993 drift guard)", () => {
  // node exec's psu-launcher.mjs directly, so it cannot import the operator-core TS twin the
  // fleet:launch-on-plan tool boundary uses (and vice-versa) — same constraint that keeps
  // normalizeModelSpec / DEFAULT_1M_FAMILY_RE in lockstep by convention. This asserts the two
  // copies agree VALUE-FOR-VALUE (ok AND the corrective message) so a change to one that is not
  // mirrored in the other fails CI here, not silently in production.
  const VECTORS = [
    // valid
    "fable:xhigh",
    "opus:max",
    "sonnet",
    "sonnet:high",
    "haiku",
    "opus[1m]:max",
    "sonnet[1m]",
    "claude-fable-5:xhigh",
    "claude-fable-5[1m]",
    "claude-sonnet-5:high",
    "claude-opus-4-8",
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "sol",
    "sol:high",
    "terra:xhigh",
    "luna",
    "luna:medium",
    "gpt-5.6-sol",
    "gpt-5.6-terra:high",
    "gpt-5.6-luna:xhigh",
    "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
    "gpt-5-codex",
    "",
    // plausible-unknown (pass)
    "o3",
    "gpt4",
    "grok",
    // rejected
    "fabel5[1m]",
    "fabel",
    "sonet",
    "sonnet5",
    "opus4",
    "opuss",
    "fabel5:xhigh",
    "opus[1m]x",
    // rejected: alias-glued-to-version shorthand (the sonnet-5 leak this guard closes)
    "sonnet-5",
    "sonnet-5:high",
    "opus-4.8",
    "haiku-4",
    "fable-5:xhigh",
    "opus-4-8",
    "sol-5.6",
    "sol-5.6:high",
    "terra-5",
    "luna-5.6",
  ];
  it("the two copies return an identical { ok, message } for every spec", () => {
    for (const s of VECTORS) {
      const a = validateModelSpec(s);
      const b = validateCloudModelSpec(s);
      expect(b.ok, s).toBe(a.ok);
      expect(b.message ?? null, s).toBe(a.message ?? null);
    }
  });
});

describe("cloud model-family/backend coupling (owner Luna→Claude incident 2026-07-10)", () => {
  it("recognizes native Codex and Claude model families", () => {
    expect(cloudModelBackendHint("gpt-5.6-luna:high")).toBe("codex");
    expect(cloudModelBackendHint("gpt-5.6-terra:high")).toBe("codex");
    expect(cloudModelBackendHint("o3")).toBe("codex");
    expect(cloudModelBackendHint("sonnet[1m]:high")).toBe("claude");
    expect(cloudModelBackendHint("claude-fable-5:xhigh")).toBe("claude");
    expect(cloudModelBackendHint("future-provider/model-1")).toBeNull();
  });

  it("infers Codex from the exact Luna spec when --agent is omitted", () => {
    const parsed = parseArgs(["--no-picker", "--model=gpt-5.6-luna:high"]);
    expect(parsed.agent).toBe("codex");
    expect(parsed.model).toBe("gpt-5.6-luna:high");
  });

  it("canonicalizes a user-facing Codex family before constructing fresh-launch argv", () => {
    const parsed = parseArgs(["--no-picker", "--model=sol:xhigh"]);
    expect(parsed).toMatchObject({
      agent: "codex",
      model: "gpt-5.6-sol:xhigh",
    });
    // The trailing window pair is the canonical D-008 config. The focused
    // policy tests pin the exact 1M/900k pair even with a stale 872k cache
    // record; this seam pins that psu carries the canonical resolver output.
    expect(modelArgsFor(parsed.agent, parsed.model)).toEqual([
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      ...codexContextConfigArgs("gpt-5.6-sol"),
    ]);
    expect(modelArgsFor("codex", "gpt-5.6-terra:high")).toEqual([
      "-m",
      "gpt-5.6-terra",
      "-c",
      'model_reasoning_effort="high"',
      ...codexContextConfigArgs("gpt-5.6-terra"),
    ]);
  });

  it("emits NO window config for a codex model that has no extended window", () => {
    // gpt-5.5 reports max_context_window == context_window, so there is nothing
    // bigger to ask for and its argv must stay byte-identical to pre-feature.
    // This is the assertion that catches a policy which "helpfully" defaults.
    expect(modelArgsFor("codex", "gpt-5.5:max")).toEqual([
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="max"',
    ]);
    expect(modelArgsFor("codex", "gpt-5.5")).toEqual(["-m", "gpt-5.5"]);
    expect(modelArgsFor("codex", "gpt-5.4-mini")).toEqual([
      "-m",
      "gpt-5.4-mini",
    ]);
  });

  it("rejects an explicit native backend mismatch regardless of flag order", () => {
    expect(() =>
      parseArgs(["--agent=claude", "--model=gpt-5.6-luna:high"]),
    ).toThrow(/belongs to the `codex` backend/);
    expect(() =>
      parseArgs(["--model=gpt-5.6-luna:high", "--agent=claude"]),
    ).toThrow(/belongs to the `codex` backend/);
    expect(() => parseArgs(["--agent=codex", "--model=opus:high"])).toThrow(
      /belongs to the `claude` backend/,
    );
  });

  it("keeps explicit OMP valid for cloud families because OMP is multi-provider", () => {
    expect(validateAgentModelPair("omp", "gpt-5.6-luna:high")).toEqual({
      ok: true,
    });
    expect(
      parseArgs(["--agent=omp", "--model=gpt-5.6-luna:high"]),
    ).toMatchObject({
      agent: "omp",
      model: "gpt-5.6-luna:high",
    });
    // `[1m]` is a Claude Code-only window marker. OMP may legitimately have
    // provider model ids containing the same family names and must see the
    // exact configured id regardless of argv order.
    expect(
      parseArgs(["--agent=omp", "--model=anthropic/claude-opus-4-6"]).model,
    ).toBe("anthropic/claude-opus-4-6");
    expect(
      parseArgs(["--model=anthropic/claude-opus-4-6", "--agent=omp"]).model,
    ).toBe("anthropic/claude-opus-4-6");
  });
});

describe("suWrapperExtraArgs ⟷ applyRoleModel model:effort CLI-flag PARITY (EI-7138 drift guard)", () => {
  // Extract the flags applyRoleModel APPENDS to a bare `<bin>` baseCmd, as a token
  // array comparable to suWrapperExtraArgs' return shape. Vectors below avoid
  // claude's `[1m]` 1M-family auto-injection (normalizeModelSpec) — a real,
  // INTENTIONAL divergence (psu injects it separately, upstream of
  // suWrapperExtraArgs, in its own parseArgs step; applyRoleModel injects it
  // inline) — by using a non-family model (haiku) so both sides start from the
  // same bare spec and the comparison isolates the model:effort→flag mapping
  // this drift guard actually cares about.
  // codex accepts BOTH `-m` and `--model` (short/long alias pair) — applyRoleModel
  // always emits the long form, suWrapperExtraArgs the short form. Functionally
  // equivalent, not the divergence this guard cares about (the EFFORT handling
  // is), so normalize both to `-m` before comparing.
  function appliedFlags(
    bin: "claude" | "codex" | "omp",
    spec: string,
  ): string[] {
    const cmd = applyRoleModel(bin, "x", spec);
    return cmd
      .slice(bin.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => (t === "--model" ? "-m" : t));
  }
  const normalize = (args: string[]): string[] =>
    args.map((t) => (t === "--model" ? "-m" : t));

  it("codex: identical argv for every spec vector (the 2026-07-03 effort-drop this ticket tracks)", () => {
    for (const spec of [
      "gpt-5.5",
      "gpt-5.5:low",
      "gpt-5.5:high",
      "gpt-5.5:xhigh",
      "gpt-5.5:max",
    ]) {
      expect(appliedFlags("codex", spec), spec).toEqual(
        normalize(suWrapperExtraArgs("codex", { model: spec })),
      );
    }
  });

  it("codex EXTENDED-window specs stay in lockstep too (plan codex-1m-context-window P-003)", () => {
    // The gpt-5.5 vectors above can NEVER catch a window-config drift: that
    // model has no extended window, so both sides correctly emit nothing and
    // the guard passes whatever either side does. These vectors are the ones
    // that fail if the window pair is added to one composer and not the other.
    for (const spec of [
      "gpt-5.6-sol",
      "gpt-5.6-sol:high",
      "sol:xhigh",
      "gpt-5.4",
    ]) {
      const psu = normalize(suWrapperExtraArgs("codex", { model: spec }));
      expect(psu.join(" "), spec).toContain("model_context_window=");
      expect(appliedFlags("codex", spec), spec).toEqual(psu);
    }
  });

  it("claude (non-1M-family spec): identical argv", () => {
    for (const spec of [
      "haiku",
      "haiku:low",
      "haiku:high",
      "haiku:max",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    ]) {
      expect(appliedFlags("claude", spec), spec).toEqual(
        normalize(suWrapperExtraArgs("claude", { model: spec })),
      );
    }
  });

  it("omp: identical argv — verbatim passthrough, never split (EI-7138: applyRoleModel used to split it, dropping the effort)", () => {
    for (const spec of [
      "opus",
      "opus:high",
      "sonnet:xhigh",
      "vendor/model:7b",
    ]) {
      // The adv-21150 title mitigation is scoped to the PSU launch paths
      // (ompTitleMitigationArgs: "every managed psu session"), so
      // suWrapperExtraArgs carries `--no-title` while applyRoleModel — the
      // harness-invoke exec boundary in operator-core — deliberately does not.
      // Strip it here: this guard's subject is the EI-7138 effort-drop class
      // (verbatim `<model>:<effort>` passthrough), not the mitigation. Whether
      // operator-spawned omp agents should ALSO carry it is a separate product
      // question, filed rather than silently decided by this assertion.
      expect(appliedFlags("omp", spec), spec).toEqual(
        normalize(suWrapperExtraArgs("omp", { model: spec })).filter(
          (a) => a !== "--no-title",
        ),
      );
    }
  });
});

describe("suWrapperExtraArgs (P-032 omp-parity passthrough)", () => {
  it("parses the new omp-convergence flags", () => {
    // haiku is outside the 1M families so no [1m] injection fires — this
    // passthrough test stays decoupled from the normalization exercised in
    // its own suite above.
    const a = parseArgs([
      "--no-picker",
      "--agent=omp",
      "--model=haiku",
      "--resume-session=s-7",
      "--launch-context=/dev/shm/k.md",
    ]);
    expect(a.model).toBe("haiku");
    expect(a.resumeSession).toBe("s-7");
    expect(a.launchContext).toBe("/dev/shm/k.md");
  });

  it("omp/claude: --model + -r; codex: -m + resume", () => {
    expect(
      suWrapperExtraArgs("omp", { model: "opus", resumeSession: "s-1" }),
    ).toEqual(["--model", "opus", "--no-title", "-r", "s-1"]);
    expect(
      suWrapperExtraArgs("claude", { model: "sonnet", resumeSession: "s-2" }),
    ).toEqual(["--model", "sonnet", "-r", "s-2"]);
    expect(
      suWrapperExtraArgs("codex", { model: "gpt-5.5", resumeSession: "s-3" }),
    ).toEqual(["-m", "gpt-5.5", "resume", "s-3"]);
  });

  it('registered Codex bootstrap budget controls native argv (WI-6554700010011827)', () => {
    const argv = suWrapperExtraArgs('codex', {
      model: 'gpt-6.1-sol:xhigh', compactionLimit: 225_000,
    });
    expect(argv).toContain('model_auto_compact_token_limit=180000');
    expect(argv).not.toContain('model_auto_compact_token_limit=784800');
  });

  it.each([
    { label: 'registered over stale launch budget', current: 225_000, legacy: 250_000, threshold: 180_000, passthrough: [] },
    { label: 'registered with absent launch budget', current: 225_000, legacy: null, threshold: 180_000, passthrough: [] },
    { label: 'legacy launch budget without registered metadata', current: null, legacy: 250_000, threshold: 200_000, passthrough: [] },
    { label: 'model default without either budget', current: null, legacy: null, threshold: 784_800, passthrough: [] },
    { label: 'registered over conflicting duplicate overrides', current: 225_000, legacy: 250_000, threshold: 180_000,
      passthrough: ['-c', 'model_auto_compact_token_limit=784800', '--config=model_auto_compact_token_limit=200000',
        '-cmodel_auto_compact_token_limit=900000', '--config', 'model_auto_compact_token_limit=600000',
        '-c=model_auto_compact_token_limit=700000', '-c', 'service_tier="fast"'] },
    { label: 'passthrough without a managed model override', current: null, legacy: null, threshold: 784_800,
      model: 'gpt-5.5', passthrough: ['-c', 'model_auto_compact_token_limit=784800', '-c', 'service_tier="fast"'] },
  ])('fresh Codex launch boundary preserves $label', async ({ current, legacy, threshold, passthrough, model = 'gpt-6.1-sol:xhigh' }) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const apiImpl = vi.fn(async () => ({
        agent: 'codex', sessionId: 'budget-test', cwd: '/unused',
        promptFile: '/unused/prompt.md', compactionLimit: current,
        envelopeEnv: { CODEX_HOME: '/unused/codex-home' },
      }));
      const runWrapperImpl = vi.fn<(options: { args: string[]; envelopeEnv: Record<string, string> }) => void>();
      await launchFreshSu({ agent: 'codex', workspace: 'budget-test' }, {
        model, account: 'auto', headless: true,
        picker: false, noKickoff: true, compactionLimit: legacy, passthrough,
      }, {
        apiImpl, runWrapperImpl,
        preflightCodexAutoPoolImpl: vi.fn(async () => true),
        runLaunchPreflightImpl: vi.fn(),
      });

      expect(apiImpl).toHaveBeenCalledWith('/api/agent-mcp/console/bootstrap-su', expect.any(Object));
      expect(runWrapperImpl).toHaveBeenCalledOnce();
      const launch = runWrapperImpl.mock.calls[0][0];
      expect(launch.envelopeEnv.CODEX_HOME).toBe('/unused/codex-home');
      const overrides: string[] = [];
      for (let i = 0; i < launch.args.length; i++) {
        const arg = launch.args[i];
        const config = arg === '-c' || arg === '--config' ? launch.args[++i]
          : arg.startsWith('--config=') ? arg.slice('--config='.length)
          : arg.startsWith('-c') ? arg.slice(2).replace(/^=/, '') : null;
        if (config?.startsWith('model_auto_compact_token_limit=')) overrides.push(config);
      }
      expect(overrides).toEqual([`model_auto_compact_token_limit=${threshold}`]);
      if (threshold !== 784_800) expect(launch.args).not.toContain('model_auto_compact_token_limit=784800');
      if (passthrough.length) expect(launch.args).toContain('service_tier="fast"');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('psu: codex (su)'));
    } finally {
      log.mockRestore();
    }
  });

  // The claude CLI takes effort as its own flag — a verbatim `<model>:<effort>` spec
  // silently drops the effort and the session falls back to the box's saved default
  // (the 2026-07-01 sonnet-5:high fleet that came up at xhigh).
  it("claude: splits a recognized `<model>:<effort>` spec into --model + --effort", () => {
    expect(
      suWrapperExtraArgs("claude", { model: "claude-sonnet-5:high" }),
    ).toEqual(["--model", "claude-sonnet-5", "--effort", "high"]);
    expect(suWrapperExtraArgs("claude", { model: "opus:max" })).toEqual([
      "--model",
      "opus",
      "--effort",
      "max",
    ]);
    // A non-effort `:` segment (e.g. a bedrock `…-v2:0` id) passes through verbatim.
    expect(
      suWrapperExtraArgs("claude", {
        model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      }),
    ).toEqual(["--model", "anthropic.claude-3-5-sonnet-20241022-v2:0"]);
    // omp keeps the suffixed spec verbatim — it parses `<model>[:<effort>]` natively.
    expect(suWrapperExtraArgs("omp", { model: "opus:high" })).toEqual([
      "--model",
      "opus:high",
      "--no-title",
    ]);
  });

  // Same effort-drop class for codex (found 2026-07-03 launching the backlog-clearance
  // codex fleet): codex's `-m` wants a bare id; effort is the config override
  // `-c model_reasoning_effort="…"`, preserving the owner-requested level.
  it("codex: splits a recognized `<model>:<effort>` spec into -m + -c model_reasoning_effort", () => {
    expect(suWrapperExtraArgs("codex", { model: "gpt-5.5:high" })).toEqual([
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="high"',
    ]);
    expect(suWrapperExtraArgs("codex", { model: "gpt-5.5:max" })).toEqual([
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="max"',
    ]);
    // bare id stays bare; a non-effort `:` segment passes through verbatim.
    expect(suWrapperExtraArgs("codex", { model: "gpt-5.5" })).toEqual([
      "-m",
      "gpt-5.5",
    ]);
    expect(suWrapperExtraArgs("codex", { model: "weird:0" })).toEqual([
      "-m",
      "weird:0",
    ]);
  });

  it("still disables OMP title generation when neither model nor resume is set", () => {
    expect(suWrapperExtraArgs("omp", {})).toEqual(["--no-title"]);
    expect(suWrapperExtraArgs("omp")).toEqual(["--no-title"]);
  });
});

describe("findUntrackedSession (resume a non-psu session by searching the agent stores)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-stores-"));
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("finds a CLAUDE session by id + recovers cwd from the jsonl (not the dir name)", () => {
    const projDir = join(home, ".claude", "projects", "-some-dashed-dir");
    mkdirSync(projDir, { recursive: true });
    // The real cwd contains a dash — dir-name decoding would be wrong; the
    // jsonl's "cwd" is authoritative.
    writeFileSync(
      join(projDir, `${UUID}.jsonl`),
      `{"sessionId":"${UUID}","cwd":"/home/me/my-repo"}\n`,
    );
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: "claude",
      sessionId: UUID,
      cwd: "/home/me/my-repo",
      untracked: true,
    });
  });

  it("finds a CODEX session by id under sessions/YYYY/MM/DD + recovers cwd", () => {
    const dir = join(home, ".codex", "sessions", "2026", "05", "31");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-05-31T09-00-00-${UUID}.jsonl`),
      `{"type":"meta","cwd":"/home/me/proj"}\n`,
    );
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: "codex",
      sessionId: UUID,
      cwd: "/home/me/proj",
      untracked: true,
    });
  });

  it("EI-155: finds an isolated-config-dir claude session + carries its configDir for the resume", () => {
    // No shared ~/.claude/projects copy — the transcript lives ONLY under the
    // per-session isolated dir (<home>/.papercusp/session-claude/<owner>/projects).
    const owner = "su-owner-1";
    const configDir = join(home, ".papercusp", "session-claude", owner);
    const projDir = join(configDir, "projects", "-iso-dir");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, `${UUID}.jsonl`),
      `{"sessionId":"${UUID}","cwd":"/home/me/iso-repo"}\n`,
    );
    // EI-9756: a hit here proves psu launched it (only psu creates the isolated
    // per-owner dir structure) — carries psuTracked so resumeFlow skips the
    // misleading "not a tracked psu launch" warning for an ended session that
    // merely fell outside the resumable window.
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: "claude",
      sessionId: UUID,
      cwd: "/home/me/iso-repo",
      untracked: true,
      configDir,
      psuTracked: true,
    });
  });

  describe("WI-10004654: a fork's seed copy never displaces the born-with owner's transcript", () => {
    // A managed fork seeds its own config dir with a copy of the source's
    // `<id>.jsonl` (same native id). The index records who the session was born
    // with; that owner's dir must win whichever order readdir returns them in.
    const seedIn = (base: string, owner: string, cwd: string) => {
      const configDir = join(base, ".papercusp", "session-claude", owner);
      const projDir = join(configDir, "projects", "-iso-dir");
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}","cwd":"${cwd}"}\n`);
      return configDir;
    };
    const seed = (owner: string, cwd: string) => seedIn(home, owner, cwd);
    /** Lay out one case: the born owner's transcript plus a fork's seed copy. */
    const layout = (base: string, born: string, fork: string, forkFirst: boolean) => {
      if (forkFirst) seedIn(base, fork, "/home/me/fork-repo");
      const bornDir = seedIn(base, born, "/home/me/born-repo");
      if (!forkFirst) seedIn(base, fork, "/home/me/fork-repo");
      return bornDir;
    };

    // readdir order differs by filesystem (XFS: creation order; tmpfs: newest
    // first; others: name or hash). Crossing creation order with name order puts
    // the fork seed first under every one of them, so a first-hit scan fails here.
    const CASES = [
      ["su-aaa-born", "su-zzz-fork", false],
      ["su-aaa-born", "su-zzz-fork", true],
      ["su-zzz-born", "su-aaa-fork", false],
      ["su-zzz-born", "su-aaa-fork", true],
    ] as const;

    it("control: the pre-fix first-hit scan picks the fork seed in at least one case on this filesystem", () => {
      // The pre-WI-10004654 scan, verbatim in shape: first owner dir (readdir
      // order) whose projects/ holds the transcript. If this never picked the fork,
      // the born-wins cases below would pass against the defect and prove nothing.
      const firstHitOwner = (base: string) => {
        const root = join(base, ".papercusp", "session-claude");
        for (const owner of readdirSync(root, { withFileTypes: true })) {
          if (!owner.isDirectory()) continue;
          const projects = join(root, owner.name, "projects");
          for (const d of readdirSync(projects, { withFileTypes: true }))
            if (d.isDirectory() && existsSync(join(projects, d.name, `${UUID}.jsonl`))) return owner.name;
        }
        return null;
      };
      const picks = CASES.map(([born, fork, forkFirst], i) => {
        const base = join(home, `case-${i}`);
        layout(base, born, fork, forkFirst);
        return firstHitOwner(base) === fork;
      });
      expect(picks).toContain(true);
    });

    for (const [born, fork, forkFirst] of CASES) {
      it(`born ${born} wins over fork seed ${fork} (fork created ${forkFirst ? "first" : "second"})`, () => {
        const bornDir = layout(home, born, fork, forkFirst);
        expect(recordSessionOwner(UUID, born, { home, advSessionId: 32370 })).toBe(true);
        expect(findUntrackedSession(UUID, { home })).toEqual({
          agent: "claude",
          sessionId: UUID,
          cwd: "/home/me/born-repo",
          untracked: true,
          configDir: bornDir,
          psuTracked: true,
        });
      });
    }

    it("with no owner index entry it still resolves to one of the hits (pre-fix behaviour)", () => {
      const a = seed("su-aaa-one", "/home/me/a");
      const b = seed("su-zzz-two", "/home/me/b");
      const hit = findUntrackedSession(UUID, { home });
      expect(hit?.psuTracked).toBe(true);
      expect([a, b]).toContain(hit?.configDir);
    });

    it("an index naming an owner with no copy on disk falls back to a real hit", () => {
      const a = seed("su-aaa-one", "/home/me/a");
      expect(recordSessionOwner(UUID, "su-elsewhere", { home })).toBe(true);
      expect(findUntrackedSession(UUID, { home })?.configDir).toBe(a);
    });
  });

  it("a non-UUID id → an omp thread name, resumed in the current dir", () => {
    expect(findUntrackedSession("my-thread", { home, cwd: "/here" })).toEqual({
      agent: "omp",
      ompThreadId: "my-thread",
      cwd: "/here",
      untracked: true,
    });
  });

  it("returns null for an unknown UUID with no matching file", () => {
    expect(findUntrackedSession(UUID, { home })).toBeNull();
  });

  it("WI-3884: finds a TRACKED codex rollout under su-codex-homes (older than the resumable window) — carries adv id + codexHome + psuTracked", () => {
    // The rollout lives ONLY in the per-session tracked home — the shared
    // ~/.codex store has no copy (tracked launches never write there). This is
    // the owner-hit case: adv row #11582 was outside the 30-row resumable
    // window, so resolveTrackedResumeSession never scanned this home.
    const codexHome = join(
      home,
      ".papercusp",
      "su-codex-homes",
      "session-11582",
    );
    const dir = join(codexHome, "sessions", "2026", "07", "10");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-07-10T14-25-16-${UUID}.jsonl`),
      `{"type":"meta","cwd":"/home/me/tracked-proj"}\n`,
    );
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: "codex",
      sessionId: UUID,
      cwd: "/home/me/tracked-proj",
      untracked: true,
      psuTracked: true,
      id: 11582,
      codexHome,
    });
  });

  it("WI-3884: a malformed tracked-home dir name still resolves (adv id null, codexHome kept)", () => {
    const codexHome = join(
      home,
      ".papercusp",
      "su-codex-homes",
      "session-not-a-number",
    );
    const dir = join(codexHome, "sessions", "2026", "07", "10");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-07-10T00-00-00-${UUID}.jsonl`),
      `{"type":"meta","cwd":"/home/me/odd"}\n`,
    );
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: "codex",
      sessionId: UUID,
      cwd: "/home/me/odd",
      untracked: true,
      psuTracked: true,
      id: null,
      codexHome,
    });
  });

  it("WI-3884: the shared ~/.codex store wins over the tracked-home scan (a raw session stays a raw resume)", () => {
    const shared = join(home, ".codex", "sessions", "2026", "07", "10");
    mkdirSync(shared, { recursive: true });
    writeFileSync(
      join(shared, `rollout-2026-07-10T01-00-00-${UUID}.jsonl`),
      `{"type":"meta","cwd":"/home/me/raw"}\n`,
    );
    const trackedDir = join(
      home,
      ".papercusp",
      "su-codex-homes",
      "session-99",
      "sessions",
      "2026",
      "07",
      "10",
    );
    mkdirSync(trackedDir, { recursive: true });
    writeFileSync(
      join(trackedDir, `rollout-2026-07-10T01-00-00-${UUID}.jsonl`),
      `{"type":"meta","cwd":"/home/me/tracked"}\n`,
    );
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: "codex",
      sessionId: UUID,
      cwd: "/home/me/raw",
      untracked: true,
    });
  });

  it("WI-3884: a CLAUDE store hit wins over a codex tracked-home hit for the same uuid (lookup order pinned)", () => {
    const projDir = join(home, ".claude", "projects", "-a-dir");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, `${UUID}.jsonl`),
      `{"sessionId":"${UUID}","cwd":"/home/me/claude-side"}\n`,
    );
    const trackedDir = join(
      home,
      ".papercusp",
      "su-codex-homes",
      "session-7",
      "sessions",
      "2026",
      "07",
      "10",
    );
    mkdirSync(trackedDir, { recursive: true });
    writeFileSync(
      join(trackedDir, `rollout-2026-07-10T01-00-00-${UUID}.jsonl`),
      `{"type":"meta","cwd":"/home/me/codex-side"}\n`,
    );
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: "claude",
      sessionId: UUID,
      cwd: "/home/me/claude-side",
      untracked: true,
    });
  });

  it("WI-3884: a SYMLINKED session dir under su-codex-homes is NOT followed (Dirent.isDirectory is lstat-like)", () => {
    // A rollout reachable ONLY through a symlinked "session-666" must stay
    // invisible — safeReaddir(withFileTypes) reports a symlink as
    // isDirectory()===false, so the scan never recurses through it. Pins the
    // no-follow property the WI-3859 pass established for archive collection.
    const realElsewhere = join(
      home,
      "elsewhere",
      "sessions",
      "2026",
      "07",
      "10",
    );
    mkdirSync(realElsewhere, { recursive: true });
    writeFileSync(
      join(realElsewhere, `rollout-2026-07-10T02-00-00-${UUID}.jsonl`),
      `{"type":"meta","cwd":"/x"}\n`,
    );
    const root = join(home, ".papercusp", "su-codex-homes");
    mkdirSync(root, { recursive: true });
    symlinkSync(join(home, "elsewhere"), join(root, "session-666"));
    expect(findUntrackedSession(UUID, { home })).toBeNull();
  });

  it("WI-3884: stray files / non-session dirs / homes without sessions/ are skipped without error", () => {
    const root = join(home, ".papercusp", "su-codex-homes");
    mkdirSync(join(root, "not-a-session-dir"), { recursive: true }); // wrong prefix
    mkdirSync(join(root, "session-11"), { recursive: true }); // no sessions/ subdir
    writeFileSync(join(root, "session-12"), "a stray FILE, not a dir\n"); // file with the prefix
    const good = join(root, "session-13", "sessions", "2026", "07", "10");
    mkdirSync(good, { recursive: true });
    writeFileSync(
      join(good, `rollout-2026-07-10T03-00-00-${UUID}.jsonl`),
      `{"type":"meta","cwd":"/home/me/ok"}\n`,
    );
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: "codex",
      sessionId: UUID,
      cwd: "/home/me/ok",
      untracked: true,
      psuTracked: true,
      id: 13,
      codexHome: join(root, "session-13"),
    });
  });

  it("WI-3884: findTrackedCodexHomeRollout degenerate inputs — null/empty id, missing root, uuid-suffix confusion", () => {
    expect(
      findTrackedCodexHomeRollout(null as unknown as string, { home }),
    ).toBeNull();
    expect(findTrackedCodexHomeRollout("", { home })).toBeNull();
    expect(findTrackedCodexHomeRollout(UUID, { home })).toBeNull(); // no su-codex-homes at all
    // A rollout for a DIFFERENT uuid that merely ENDS with the searched id's
    // tail must not match — the filename match is `-<full id>.jsonl`.
    const dir = join(
      home,
      ".papercusp",
      "su-codex-homes",
      "session-21",
      "sessions",
      "2026",
      "07",
      "10",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(
        dir,
        `rollout-2026-07-10T04-00-00-ffffffff-ffff-7fff-8fff-${UUID.slice(-12)}.jsonl`,
      ),
      '{"cwd":"/x"}\n',
    );
    expect(findTrackedCodexHomeRollout(UUID, { home })).toBeNull();
  });
});

describe("direct su-ID tracked-session recovery", () => {
  const owner = "su-12345678-1234-4abc-8abc-123456789abc";
  const latest = { id: 31413, agent: "codex", coordOwnerId: owner, sessionId: "latest-native-id" };

  it.each(["claude", "codex", "omp"])("resolves the latest %s row even when an older row is cached", async (agent) => {
    const source = { ...latest, agent };
    const apiImpl = vi.fn(async () => ({
      exact: { id: source.id, ownerId: owner, requestedAgentId: owner },
      sessions: [{ ...source, id: 99, sessionId: "older-native-id" }, source],
    }));
    expect(await resolveDirectTrackedResumeSession([{ ...source, id: 99 }], owner, { apiImpl })).toBe(source);
    expect(apiImpl).toHaveBeenCalledExactlyOnceWith(`/api/adv/sessions/resumable?agentId=${owner}`);
    expect(resumeEnvFor(source).PAPERCUSP_SID).toBe(owner);
  });

  it.each([
    { name: "absent agent", result: { sessions: [] } },
    { name: "old server without exact resolution but with an exact owner row", result: { sessions: [latest] }, expected: latest },
    { name: "different owner", result: { exact: { id: latest.id, ownerId: "su-other", requestedAgentId: owner }, sessions: [latest] } },
    { name: "different requested agent", result: { exact: { id: latest.id, ownerId: owner, requestedAgentId: "su-other" }, sessions: [latest] } },
    { name: "different row", result: { exact: { id: 999, ownerId: owner, requestedAgentId: owner }, sessions: [latest] } },
    { name: "legacy different owner", result: { sessions: [{ ...latest, coordOwnerId: "su-other" }] } },
    { name: "legacy owner prefix", result: { sessions: [{ ...latest, coordOwnerId: owner + "a" }] } },
  ])("handles a $name response", async ({ result, expected = null }) => {
    const apiImpl = async (path) => path.includes("/roster/agent?") && expected
      ? { ownerId: owner, nativeSession: { backend: "codex", source: "adv_sessions", ownerId: owner, codexHome: `/tmp/session-${expected.id}` } }
      : result;
    expect(await resolveDirectTrackedResumeSession([], owner, { apiImpl })).toBe(expected);
  });

  it("keeps the newest legacy registration without using mutable activity order", async () => {
    const source = { ...latest, cwd: "/repo" };
    const apiImpl = vi.fn(async (path) => path.includes("/roster/agent?")
      ? { ownerId: owner, nativeSession: { backend: "codex", source: "adv_sessions", ownerId: owner, codexHome: `/tmp/session-${source.id}` } }
      : { sessions: [
      { ...source, id: 100, sessionId: "older-native-id" },
      { ...source, id: 99999, coordOwnerId: "su-other" },
      source,
    ] });
    expect(await resolveDirectTrackedResumeSession([], owner, { apiImpl })).toBe(source);
  });

  it.each(["codex", "omp", "claude"])("recovers an out-of-window %s owner through its exact native handle", async (agent) => {
    const source = { ...latest, agent, sessionId: "11111111-1111-4111-8111-111111111111" };
    const handle = {
      backend: agent, source: "adv_sessions", ownerId: owner,
      codexHome: `/home/test/.papercusp/su-codex-homes/session-${source.id}`,
      agentHome: `/home/test/.papercusp/su-omp-homes/session-${source.id}/agent`,
      sessionId: source.sessionId,
    };
    const exactPath = agent === "claude"
      ? `/api/adv/sessions/resumable?sessionId=${source.sessionId}`
      : `/api/adv/sessions/resumable?id=${source.id}`;
    const apiImpl = vi.fn(async (path) => {
      if (path.includes("?agentId=")) return { sessions: [{ ...source, id: 99 }] };
      if (path.includes("/roster/agent?owner=")) return { ownerId: owner, nativeSession: handle };
      if (path === exactPath) return {
        sessions: [{ ...source, id: 99 }, source],
        exact: { id: source.id, ownerId: owner, requestedSessionId: source.sessionId },
      };
      throw new Error(`unexpected lookup: ${path}`);
    });
    expect(await resolveDirectTrackedResumeSession([], owner, { apiImpl })).toBe(source);
    expect(apiImpl.mock.calls.map(([path]) => path)).toEqual([
      `/api/adv/sessions/resumable?agentId=${owner}`,
      `/api/adv/roster/agent?owner=${owner}`,
      exactPath,
    ]);
  });

  it.each([
    { ownerId: "su-other", nativeSession: { backend: "codex", source: "adv_sessions", ownerId: owner } },
    { ownerId: owner, nativeSession: { backend: "codex", source: "adv_sessions", ownerId: "su-other" } },
    { ownerId: owner, nativeSession: { backend: "codex", source: "spawned_agents", ownerId: owner } },
    { ownerId: owner, nativeSession: null },
  ])("refuses an unproven legacy dossier binding %#", async (detail) => {
    const apiImpl = vi.fn(async (path) => path.includes("?agentId=") ? { sessions: [] } : detail);
    expect(await resolveDirectTrackedResumeSession([], owner, { apiImpl })).toBeNull();
    expect(apiImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...latest, coordOwnerId: "su-other" },
    { ...latest, agent: "claude" },
    { ...latest, id: 99999 },
  ])("does not trust a legacy native-store path over the exact row identity %#", async (source) => {
    const apiImpl = vi.fn(async (path) => path.includes("/roster/agent?")
      ? { ownerId: owner, nativeSession: { backend: "codex", source: "adv_sessions", ownerId: owner, codexHome: `/tmp/session-${latest.id}` } }
      : { sessions: path.includes("?id=") ? [source] : [] });
    expect(await resolveDirectTrackedResumeSession([], owner, { apiImpl })).toBeNull();
  });

  it("reports an unsupported legacy handle rather than blaming a valid owner ID", async () => {
    const apiImpl = vi.fn(async (path) => path.includes("?agentId=") ? { sessions: [] } : {
      ownerId: owner, nativeSession: { backend: "codex", source: "adv_sessions", ownerId: owner, codexHome: "/tmp/custom-store" },
    });
    await expect(resolveDirectTrackedResumeSession([], owner, { apiImpl })).rejects.toThrow("upgrade the operator");
  });

  it("propagates an out-of-window owner-handle read failure", async () => {
    const apiImpl = vi.fn(async (path) => {
      if (path.includes("?agentId=")) return { sessions: [] };
      throw new Error("operator unavailable during owner lookup");
    });
    await expect(resolveDirectTrackedResumeSession([], owner, { apiImpl })).rejects.toThrow("operator unavailable during owner lookup");
  });

  it.each(["ownerId", "requestedSessionId", "id"])("checks the legacy Claude exact %s binding", async (field) => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const source = { ...latest, agent: "claude", sessionId };
    const apiImpl = vi.fn(async (path) => {
      if (path.includes("?agentId=")) return { sessions: [] };
      if (path.includes("/roster/agent?")) return {
        ownerId: owner, nativeSession: { backend: "claude", source: "adv_sessions", ownerId: owner, sessionId },
      };
      return { sessions: [source], exact: { id: source.id, ownerId: owner, requestedSessionId: sessionId, [field]: "foreign-binding" } };
    });
    expect(await resolveDirectTrackedResumeSession([], owner, { apiImpl })).toBeNull();
  });

  it("propagates owner lookup failure instead of interpreting the su ID as a native thread", async () => {
    await expect(resolveDirectTrackedResumeSession([], owner, {
      apiImpl: async () => { throw new Error("operator unavailable"); },
    })).rejects.toThrow("operator unavailable");
  });

  it.each([["--resume", owner], [`--resume=${owner}`]])("parses the owner ID in %j", (...args) => {
    expect(parseArgs(args)).toMatchObject({ resume: true, resumeId: owner });
  });
});

describe("direct numeric tracked-session recovery (EI-24966472541417677)", () => {
  const source = {
    id: 31413,
    agent: "claude",
    sessionId: "ef31338b-ef6d-4a88-be7c-5ed60166e718",
    cwd: "/repo/source",
    workspaceId: "source-workspace",
    planSlug: "source-plan",
    coordOwnerId: "su-original-source",
  };
  const recent = { ...source, id: 34304, coordOwnerId: "su-recent" };

  it("keeps a recent tracked source without another server read", async () => {
    const apiImpl = vi.fn();
    expect(await resolveDirectTrackedResumeSession([source], "31413", { apiImpl })).toBe(source);
    expect(apiImpl).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex", "omp"])(
    "recovers the exact older %s row instead of treating its adv id as an OMP thread",
    async (agent) => {
      const historical = { ...source, agent, ompThreadId: agent === "omp" ? "source-thread" : null };
      const apiImpl = vi.fn(async () => ({ sessions: [recent, historical] }));
      const recovered = await resolveDirectTrackedResumeSession([recent], "31413", { apiImpl });
      expect(apiImpl).toHaveBeenCalledExactlyOnceWith("/api/adv/sessions/resumable?id=31413");
      expect(recovered).toBe(historical);
      expect(recovered).toMatchObject({
        sessionId: source.sessionId,
        coordOwnerId: source.coordOwnerId,
        workspaceId: source.workspaceId,
        planSlug: source.planSlug,
      });
    },
  );

  it.each([
    { name: "missing", sessions: [] },
    { name: "different", sessions: [recent] },
  ])("does not bless a $name exact row", async ({ sessions }) => {
    const apiImpl = vi.fn(async () => ({ sessions }));
    expect(await resolveDirectTrackedResumeSession([], "31413", { apiImpl })).toBeNull();
    expect(apiImpl).toHaveBeenCalledOnce();
  });

  it.each([source.sessionId, "native-omp-thread", "0", "-1", "12.5", "1e3", "9007199254740992"])(
    "leaves native or invalid adv id %s to its existing guarded path",
    async (id) => {
      const home = mkdtempSync(join(tmpdir(), "psu-unbound-native-resume-"));
      try {
        const apiImpl = vi.fn();
        expect(await resolveDirectTrackedResumeSession([], id, { home, apiImpl })).toBeNull();
        expect(apiImpl).not.toHaveBeenCalled();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("propagates an exact-read failure instead of falling through to a raw source", async () => {
    const apiImpl = vi.fn(async () => { throw new Error("operator unavailable"); });
    await expect(resolveDirectTrackedResumeSession([], "31413", { apiImpl }))
      .rejects.toThrow("operator unavailable");
  });

  it("recovers an out-of-window native UUID through its durable binding when the transcript is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "psu-mapped-native-resume-"));
    try {
      const historical = { ...source, agent: "codex" };
      recordSessionOwner(source.sessionId, source.coordOwnerId, { home, advSessionId: source.id });
      const apiImpl = vi.fn(async () => ({ sessions: [historical] }));
      const other = { ...recent, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      expect(await resolveDirectTrackedResumeSession([other], source.sessionId, { home, apiImpl }))
        .toBe(historical);
      expect(apiImpl).toHaveBeenCalledExactlyOnceWith("/api/adv/sessions/resumable?id=31413");
      expect(existsSync(join(home, ".papercusp", "su-codex-homes", "session-31413"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "missing", sessions: [] },
    { name: "different tracked id", sessions: [{ ...source, id: 34304 }] },
    { name: "different native incarnation", sessions: [{ ...source, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] },
    { name: "different owner", sessions: [{ ...source, coordOwnerId: "su-other" }] },
  ])("does not bless a mapped UUID with a $name exact row", async ({ sessions }) => {
    const home = mkdtempSync(join(tmpdir(), "psu-mapped-native-refusal-"));
    try {
      recordSessionOwner(source.sessionId, source.coordOwnerId, { home, advSessionId: source.id });
      const apiImpl = vi.fn(async () => ({ sessions }));
      expect(await resolveDirectTrackedResumeSession([], source.sessionId, { home, apiImpl })).toBeNull();
      expect(apiImpl).toHaveBeenCalledExactlyOnceWith("/api/adv/sessions/resumable?id=31413");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("propagates mapped UUID lookup failure rather than misreporting it as an untracked source", async () => {
    const home = mkdtempSync(join(tmpdir(), "psu-mapped-native-read-failure-"));
    try {
      recordSessionOwner(source.sessionId, source.coordOwnerId, { home, advSessionId: source.id });
      const apiImpl = vi.fn(async () => { throw new Error("operator unavailable"); });
      await expect(resolveDirectTrackedResumeSession([], source.sessionId, { home, apiImpl }))
        .rejects.toThrow("operator unavailable");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("direct resume of an archived consult incarnation (EI-25730332883266828)", () => {
  it.each(["claude", "codex", "omp"])(
    "ports the selected %s archive even when the tracked row's newest transcript is missing",
    async (agent) => {
      const home = mkdtempSync(join(tmpdir(), "psu-archived-consult-"));
      const earlier = "11111111-1111-4111-8111-111111111111";
      const source = {
        id: 35200, agent, cwd: "/repo/source", role: null,
        sessionId: "22222222-2222-4222-8222-222222222222",
        ompThreadId: agent === "omp" ? "newest-thread" : null,
        coordOwnerId: "su-original-source", workspaceId: "source-workspace",
        configDir: home, codexHome: home,
      };
      const before = structuredClone(source);
      const args = {
        resumeId: String(source.id), picker: false, agent: "codex", model: "sol:high",
        ownerId: "su-isolated-answer", launchedBy: "su-requester",
        consultEvidenceSpan: { sessionId: earlier, turnIndices: [2, 4], contextTurns: 2 },
      };
      const apiImpl = vi.fn(async (path) => ({
        sessions: path.includes("?id=") ? [source] : [],
      }));
      const sessionPortApiImpl = vi.fn()
        .mockResolvedValueOnce({ inspection: {
          source: { nativeSessionId: earlier, sha256: "a".repeat(64) },
        } })
        .mockResolvedValueOnce({ portId: "port-archive", token: "port-archive.token" });
      const launchFreshSuImpl = vi.fn();
      const launchResolvedResumeImpl = vi.fn(async (row, launchArgs, options) => {
        expect(options).toEqual({ tracked: true });
        const target = resolveResumeTarget(row, launchArgs);
        expect(target.operation).toBe("port");
        await launchSessionPort(row, target, {}, launchArgs, {
          sessionPortApiImpl, launchFreshSuImpl,
        });
      });
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("latest native transcript rejected before port inspection");
      });
      // The old premature restore must fail deterministically, without making
      // an operator request or touching an actual archived session.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: false }), { status: 404 }),
      );
      try {
        if (agent !== "omp") expect(sessionHasTranscript(source, { home })).toBe(false);
        await resumeFlow(args, { apiImpl, launchResolvedResumeImpl });
        expect(apiImpl).toHaveBeenCalledWith("/api/adv/sessions/resumable?id=35200");
        expect(exit).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(launchFreshSuImpl).toHaveBeenCalledOnce();
        const inspect = JSON.parse(sessionPortApiImpl.mock.calls[0][1].body);
        const prepare = JSON.parse(sessionPortApiImpl.mock.calls[1][1].body);
        expect(inspect).toMatchObject({
          sourceAdvSessionId: source.id, sourceNativeSessionId: earlier,
          consultEvidenceSpan: args.consultEvidenceSpan, targetOwnerId: args.ownerId,
        });
        expect(prepare).toEqual({ ...inspect, expectedSourceHash: "a".repeat(64) });
        expect(source).toEqual(before);
      } finally {
        fetchSpy.mockRestore(); exit.mockRestore(); stderr.mockRestore();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe("out-of-window tracked-session recovery (WI-10002877)", () => {
  const diskHit = {
    agent: "claude",
    sessionId: "0123abcd-1234-5678-9abc-def012345678",
    cwd: "/repo/from-transcript",
    untracked: true,
    psuTracked: true,
    id: 29676,
    configDir: "/home/u/.papercusp/session-claude/su-source",
  };
  const durableRow = {
    id: 29676,
    agent: "claude",
    sessionId: "older-recorded-native-id",
    cwd: "/repo/from-row",
    workspaceId: "papercusp-workspace",
    planSlug: "source-plan",
    coordOwnerId: "su-source",
  };

  it("asks the existing resumable surface for the one durable row by id", () => {
    expect(exactTrackedResumePath(diskHit)).toBe(
      "/api/adv/sessions/resumable?id=29676",
    );
    expect(
      exactTrackedResumePath({ ...diskHit, psuTracked: false }),
    ).toBeNull();
    expect(exactTrackedResumePath({ ...diskHit, id: null })).toBeNull();
  });

  it("restores managed scope while preserving the exact transcript/config hit", () => {
    expect(
      rehydrateOutOfWindowTrackedSession(diskHit, { sessions: [durableRow] }),
    ).toEqual({
      ...durableRow,
      sessionId: diskHit.sessionId,
      cwd: diskHit.cwd,
      configDir: diskHit.configDir,
    });
  });

  it("does not bless a different or missing durable row as tracked", () => {
    expect(
      rehydrateOutOfWindowTrackedSession(diskHit, { sessions: [] }),
    ).toBeNull();
    expect(
      rehydrateOutOfWindowTrackedSession(diskHit, {
        sessions: [{ ...durableRow, id: 99 }],
      }),
    ).toBeNull();
  });
});

describe("carry-respawn incarnation recovery (WI-10003198)", () => {
  // Measured shape (2026-09-26): transcript fa2b9674 is an EARLIER incarnation of
  // su-5078d176. Its owner's only row (#29793) carries the LATER native id, the
  // local owner index holds no row id for it, and the transcript sits in the
  // owner's isolated config dir. psu refused every consult fork/convert of it.
  const home = "/home/u";
  const ownerDir = "/home/u/.papercusp/session-claude/su-5078d176";
  const earlier = "fa2b9674-2646-42fa-9135-3909f93fcd9a";
  const diskHit = {
    agent: "claude",
    sessionId: earlier,
    cwd: "/repo",
    untracked: true,
    psuTracked: true,
    id: null,
    configDir: ownerDir,
  };
  const ownersRow = {
    id: 29793,
    agent: "claude",
    sessionId: "f56ecb13-112b-4e1b-931b-34af1c6f274b",
    cwd: "/repo",
    workspaceId: "papercusp-workspace",
    planSlug: null,
    coordOwnerId: "su-5078d176",
  };
  beforeEach(() => {
    // sessionClaudeRoot honours this override; a psu-launched test runner can carry it.
    vi.stubEnv("PAPERCUSP_SESSION_CLAUDE_DIR", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks the server to bridge a native uuid only for a psu-tracked hit", () => {
    expect(exactTrackedResumeBySessionPath(diskHit)).toBe(
      `/api/adv/sessions/resumable?sessionId=${earlier}`,
    );
    expect(exactTrackedResumeBySessionPath({ ...diskHit, psuTracked: false })).toBeNull();
    expect(exactTrackedResumeBySessionPath({ ...diskHit, sessionId: "omp-thread" })).toBeNull();
  });

  it("reads the transcript's owner from its isolated config dir, and nothing else", () => {
    expect(transcriptOwnerFromConfigDir(diskHit, home)).toBe("su-5078d176");
    expect(transcriptOwnerFromConfigDir({ configDir: "/elsewhere/su-x" }, home)).toBeNull();
    expect(transcriptOwnerFromConfigDir({}, home)).toBeNull();
  });

  it("recovers the owner's row through the session bridge and keeps the earlier transcript", async () => {
    const calls: string[] = [];
    const apiImpl = async (path: string) => {
      calls.push(path);
      return { sessions: [ownersRow], exact: { id: 29793, ownerId: "su-5078d176", requestedSessionId: earlier } };
    };
    const { tracked, reasons } = await recoverOutOfWindowTrackedSession(diskHit, { apiImpl, home });
    expect(calls).toEqual([`/api/adv/sessions/resumable?sessionId=${earlier}`]);
    expect(reasons).toEqual([]);
    // The row supplies identity/scope (id, owner, workspace); the disk hit
    // supplies the transcript actually requested — never the row's later one.
    expect(tracked).toMatchObject({
      id: 29793,
      coordOwnerId: "su-5078d176",
      workspaceId: "papercusp-workspace",
      sessionId: earlier,
      configDir: ownerDir,
    });
  });

  it("never trusts an owner-index row that belongs to a different owner than the transcript dir", async () => {
    const foreign = { ...ownersRow, id: 31000, coordOwnerId: "su-consult-revival" };
    const apiImpl = async (path: string) =>
      path.includes("?id=31000")
        ? { sessions: [foreign] }
        : { sessions: [ownersRow], exact: { id: 29793, ownerId: "su-5078d176", requestedSessionId: earlier } };
    const { tracked, reasons } = await recoverOutOfWindowTrackedSession(
      { ...diskHit, id: 31000 },
      { apiImpl, home },
    );
    expect(tracked).toMatchObject({ id: 29793, coordOwnerId: "su-5078d176", sessionId: earlier });
    expect(reasons.join(" ")).toMatch(/owner-index row #31000 belongs to su-consult-revival/);
  });

  it("refuses a session-bridge row whose owner disagrees with the transcript dir", async () => {
    const apiImpl = async () => ({
      sessions: [{ ...ownersRow, coordOwnerId: "su-someone-else" }],
      exact: { id: 29793, ownerId: "su-someone-else", requestedSessionId: earlier },
    });
    const { tracked, reasons } = await recoverOutOfWindowTrackedSession(diskHit, { apiImpl, home });
    expect(tracked).toBeNull();
    expect(reasons.join(" ")).toMatch(/session-bridge row #29793 belongs to su-someone-else/);
  });

  it("returns concrete reasons, never a throw, when nothing can be recovered", async () => {
    // An operator that predates the sessionId lookup answers with the plain window.
    const older = await recoverOutOfWindowTrackedSession(diskHit, {
      apiImpl: async () => ({ sessions: [] }),
      home,
    });
    expect(older.tracked).toBeNull();
    expect(older.reasons.join(" ")).toMatch(/resolved no tracked row .* predate the sessionId lookup/);

    const broken = await recoverOutOfWindowTrackedSession(diskHit, {
      apiImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      home,
    });
    expect(broken.tracked).toBeNull();
    expect(broken.reasons.join(" ")).toMatch(/session-bridge read failed \(ECONNREFUSED\)/);

    const nothing = await recoverOutOfWindowTrackedSession(
      { ...diskHit, psuTracked: false },
      { apiImpl: async () => ({ sessions: [] }), home },
    );
    expect(nothing).toEqual({ tracked: null, reasons: ["no row id and no native session uuid to look up"] });
  });
});

describe("session-owner index (identity-split fix 2026-07-02 — untracked resume keeps its born SID)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  const FORK_UUID = "ffffabcd-1234-5678-9abc-def012345678";
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-owners-"));
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("record → recover roundtrips the born coordOwnerId", () => {
    expect(recordSessionOwner(UUID, "su-born", { home })).toBe(true);
    expect(recoverSessionOwner(UUID, { home })).toBe("su-born");
  });

  it("FIRST WRITE WINS — a later launch under a different SID cannot rebind", () => {
    expect(recordSessionOwner(UUID, "su-born", { home })).toBe(true);
    expect(recordSessionOwner(UUID, "su-imposter", { home })).toBe(false);
    expect(recoverSessionOwner(UUID, { home })).toBe("su-born");
  });

  it("never blocks a launch: missing ids are a no-op, misses/corrupt entries recover null", () => {
    expect(recordSessionOwner(null, "su-x", { home })).toBe(false);
    expect(recordSessionOwner(UUID, null, { home })).toBe(false);
    expect(recoverSessionOwner(UUID, { home })).toBeNull();
    expect(recoverSessionOwner(null, { home })).toBeNull();
    mkdirSync(sessionOwnersRoot(home), { recursive: true });
    writeFileSync(join(sessionOwnersRoot(home), UUID), "not json\n");
    expect(recoverSessionOwner(UUID, { home })).toBeNull();
  });

  it("carries the adv row id when known (debuggability, not identity)", () => {
    recordSessionOwner(UUID, "su-born", { home, advSessionId: "42" });
    const raw = JSON.parse(
      readFileSync(join(sessionOwnersRoot(home), UUID), "utf8"),
    );
    expect(raw).toMatchObject({ v: 1, ownerId: "su-born", advSessionId: "42" });
    expect(recoverSessionIdentity(UUID, { home })).toEqual({ ownerId: "su-born", advSessionId: 42 });
  });

  it("recovers the concrete adv row id alongside the born owner for an out-of-window resume", () => {
    recordSessionOwner(UUID, "su-born", { home, advSessionId: "77" });
    expect(recoverResumeSessionIdentity({ agent: "claude", sessionId: UUID }, { home })).toEqual({
      ownerId: "su-born",
      advSessionId: 77,
    });
  });

  it("WI-1863: adv-keyed entry resolves an omp launch (no native UUID) to its ownerId", () => {
    // omp launches yield nativeSessionIdFromLaunchArgs=null → the native-id write is a
    // no-op; the launcher ALSO records `adv-<advSessionId>` so a desktop session-<N> is
    // locally resolvable (the 2026-07-03 ornith misdelivery incident).
    expect(
      recordSessionOwner(
        nativeSessionIdFromLaunchArgs(["--approval-mode", "yolo"]),
        "su-omp-leader",
        { home },
      ),
    ).toBe(false);
    expect(
      recordSessionOwner("adv-9965", "su-omp-leader", {
        home,
        advSessionId: "9965",
      }),
    ).toBe(true);
    expect(recoverSessionOwner("adv-9965", { home })).toBe("su-omp-leader");
    // first-write-wins holds for adv keys too
    expect(
      recordSessionOwner("adv-9965", "su-imposter", {
        home,
        advSessionId: "9965",
      }),
    ).toBe(false);
    expect(recoverSessionOwner("adv-9965", { home })).toBe("su-omp-leader");
  });

  it("nativeSessionIdFromLaunchArgs: fresh launch (--session-id) and both resume forms", () => {
    expect(nativeSessionIdFromLaunchArgs(["--session-id", UUID])).toBe(UUID);
    expect(nativeSessionIdFromLaunchArgs([`--session-id=${UUID}`])).toBe(UUID);
    expect(
      nativeSessionIdFromLaunchArgs([
        "--resume",
        UUID,
        "--dangerously-skip-permissions",
      ]),
    ).toBe(UUID);
    expect(nativeSessionIdFromLaunchArgs([`--resume=${UUID}`])).toBe(UUID);
    expect(nativeSessionIdFromLaunchArgs(["resume", UUID])).toBe(UUID); // codex subcommand
  });

  it("nativeSessionIdFromLaunchArgs: a tracked fork binds the FORK id, never the original", () => {
    // launchTrackedFork argv shape: claude --resume <orig> --fork-session --session-id <forkId>
    expect(
      nativeSessionIdFromLaunchArgs([
        "--resume",
        UUID,
        "--fork-session",
        "--session-id",
        FORK_UUID,
      ]),
    ).toBe(FORK_UUID);
  });

  it("nativeSessionIdFromLaunchArgs: a fork with no forced id binds NOTHING (new id unknowable)", () => {
    expect(
      nativeSessionIdFromLaunchArgs(["--resume", UUID, "--fork-session"]),
    ).toBeNull();
    expect(nativeSessionIdFromLaunchArgs(["fork", UUID])).toBeNull(); // codex fork
  });

  it("nativeSessionIdFromLaunchArgs: non-UUID values and empty argv match nothing", () => {
    expect(
      nativeSessionIdFromLaunchArgs(["--resume", "my-omp-thread"]),
    ).toBeNull();
    expect(nativeSessionIdFromLaunchArgs([])).toBeNull();
    expect(nativeSessionIdFromLaunchArgs()).toBeNull();
  });

  it("WI-40723: tracked Codex recovery prefers the adv-keyed born owner and never mints a split SID", () => {
    const codexHome = join(
      home,
      ".papercusp",
      "su-codex-homes",
      "session-16515",
    );
    const dir = join(codexHome, "sessions", "2026", "08", "22");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-08-22T17-00-00-${UUID}.jsonl`),
      '{"type":"session_meta","payload":{"cwd":"/home/me/tracked-proj"}}\n',
    );
    recordSessionOwner("adv-16515", "su-born-leader", {
      home,
      advSessionId: "16515",
    });

    const untracked = findUntrackedSession(UUID, { home });
    expect(untracked).toMatchObject({
      agent: "codex",
      sessionId: UUID,
      id: 16515,
      codexHome,
      psuTracked: true,
    });
    expect(recoverSessionOwner(UUID, { home })).toBeNull();
    expect(recoverResumeSessionOwner(untracked, { home })).toBe(
      "su-born-leader",
    );

    // A later split launch may have written the UUID key under its freshly
    // minted SID. The adv-row binding remains canonical and must still win.
    recordSessionOwner(UUID, "su-later-split", { home, advSessionId: "16515" });
    const bornOwnerId = recoverResumeSessionOwner(untracked, { home });
    const mintSid = vi.fn(() => "su-new-split");
    expect(
      resumeEnvFor({ ...untracked, coordOwnerId: bornOwnerId }, { mintSid }),
    ).toMatchObject({
      PAPERCUSP_SID: "su-born-leader",
      PAPERCUSP_ADV_SESSION_ID: "16515",
    });
    expect(mintSid).not.toHaveBeenCalled();
  });

  it("END-TO-END: the untracked-resume path re-attaches the born identity instead of minting", () => {
    // Launch time (runWrapper): the fresh session recorded its binding.
    recordSessionOwner(
      nativeSessionIdFromLaunchArgs(["--session-id", UUID]),
      "su-born",
      { home },
    );
    // Later, the adv row is gone → findUntrackedSession knows no identity…
    const untracked = {
      agent: "claude",
      sessionId: UUID,
      cwd: "/x",
      untracked: true,
    };
    // …but resumeFlow recovers the born owner before resumeEnvFor can mint.
    const born = recoverSessionOwner(untracked.sessionId, { home });
    if (born) (untracked as { coordOwnerId?: string }).coordOwnerId = born;
    expect(
      resumeEnvFor(untracked, { mintSid: () => "su-freshly-minted" })
        .PAPERCUSP_SID,
    ).toBe("su-born");
  });
});

describe("mintRecycleArgs (WI-1980 — a cold-loop RECYCLE respawn gets a FRESH --session-id)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  const FRESH = "ffffabcd-1234-5678-9abc-def012345678";
  const mintId = () => FRESH;

  it("replaces the --session-id VALUE (space form) with a fresh id, preserving everything else", () => {
    const { args, nativeId } = mintRecycleArgs(
      [
        "claude",
        "--session-id",
        UUID,
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
      ],
      { mintId },
    );
    expect(nativeId).toBe(FRESH);
    expect(args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
    ]);
    // The old id must be gone (that collision is the whole bug).
    expect(args).not.toContain(UUID);
  });

  it("replaces the --session-id=<uuid> (equals form) too", () => {
    const { args, nativeId } = mintRecycleArgs(
      ["claude", `--session-id=${UUID}`, "--foo"],
      { mintId },
    );
    expect(nativeId).toBe(FRESH);
    expect(args).toEqual(["claude", `--session-id=${FRESH}`, "--foo"]);
  });

  it("strips warm-resume flags (--resume/--continue/--fork-session) — a recycle is a clean boot", () => {
    // A tracked-fork argv shape carries resume + fork alongside the forced id.
    const { args, nativeId } = mintRecycleArgs(
      [
        "claude",
        "--resume",
        UUID,
        "--fork-session",
        "--session-id",
        UUID,
        "--add-dir=/d",
      ],
      { mintId },
    );
    expect(nativeId).toBe(FRESH);
    expect(args).toEqual(["claude", "--session-id", FRESH, "--add-dir=/d"]);
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--fork-session");
    // The consumed --resume VALUE token is gone too (no dangling uuid).
    expect(args.filter((a) => a === UUID)).toEqual([]);
  });

  it("strips --continue and the --resume=<uuid> equals form", () => {
    const { args } = mintRecycleArgs(
      ["claude", "--continue", `--resume=${UUID}`, "--session-id", UUID],
      { mintId },
    );
    expect(args).toEqual(["claude", "--session-id", FRESH]);
  });

  it("is a NO-OP (same array ref, nativeId null) when the argv carries no --session-id (e.g. omp)", () => {
    const src = ["omp", "--approval-mode", "yolo"];
    const out = mintRecycleArgs(src, { mintId });
    expect(out.nativeId).toBeNull();
    expect(out.args).toBe(src); // identity — nothing to rotate, respawn is byte-identical
    // Even with an explicit non-claude agent hint the argv is untouched
    // (--session-id is a claude flag).
    expect(mintRecycleArgs(src, { mintId, agent: "omp" }).args).toBe(src);
  });

  it("SYNTHESIZES a fresh --session-id for a RESUME-launched claude argv (agent hint, owner-reported 2026-07-18)", () => {
    // A `psu --resume` session launches as `claude --resume <id>` with NO
    // --session-id — before the fix its host could never mint carry-respawn
    // argv, so the watchdog's forced cut failed argv-build on EVERY sweep
    // ("carry-respawn requires a Claude --session-id launch" terminal spam) and
    // the session ran unpoliced.
    const { args, nativeId } = mintRecycleArgs(
      ["claude", "--resume", UUID, "--add-dir=/d"],
      {
        mintId,
        agent: "claude",
      },
    );
    expect(nativeId).toBe(FRESH);
    expect(args).toEqual(["claude", "--add-dir=/d", "--session-id", FRESH]);
    expect(args).not.toContain(UUID); // the warm-resume target is gone — clean boot
  });

  it("defaults to a real randomUUID when no mintId is injected (fresh, well-formed, ≠ the old id)", () => {
    const { args, nativeId } = mintRecycleArgs([
      "claude",
      "--session-id",
      UUID,
    ]);
    expect(nativeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(nativeId).not.toBe(UUID);
    expect(args).toEqual(["claude", "--session-id", nativeId]);
  });

  it("tolerates empty / missing argv", () => {
    expect(mintRecycleArgs([], { mintId })).toEqual({
      args: [],
      nativeId: null,
    });
    expect(mintRecycleArgs(undefined, { mintId })).toEqual({
      args: [],
      nativeId: null,
    });
  });
});

describe("respawn model carry (WI-2141859 — an in-session /model switch must survive the respawn)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  const FRESH = "ffffabcd-1234-5678-9abc-def012345678";
  const mintId = () => FRESH;
  // The exact specs measured on the live fleet 2026-09-02: the flag the chain
  // was launched with, and the model the owner's `/model` switch actually ran.
  const LAUNCHED = "claude-fable-5-1[1m]";
  const SWITCHED_TO = "claude-opus-5";

  describe("splitRespawnModelSpec", () => {
    it("separates identity from the effort suffix and the window marker", () => {
      expect(splitRespawnModelSpec("claude-fable-5-1[1m]:max")).toEqual({
        id: "claude-fable-5-1",
        effort: "max",
      });
      expect(splitRespawnModelSpec("claude-opus-5")).toEqual({
        id: "claude-opus-5",
        effort: "",
      });
    });

    it("does NOT treat a non-effort colon suffix as effort", () => {
      // A provider-qualified id (`vendor/model:tag`) must keep its tag as part of
      // the identity — mis-splitting it would compare two different models equal.
      expect(splitRespawnModelSpec("openrouter/stealth/ox-alpha:preview")).toEqual({
        id: "openrouter/stealth/ox-alpha:preview",
        effort: "",
      });
    });
  });

  describe("reconcileRespawnModelSpec", () => {
    it("re-pins the successor to the model the session actually switched to", () => {
      // THE bug, in one assertion: launched on fable, `/model`-switched to opus,
      // so the successor must launch on opus — not on the inherited fable flag.
      expect(reconcileRespawnModelSpec(LAUNCHED, SWITCHED_TO)).toBe(
        "claude-opus-5[1m]",
      );
    });

    it("carries the inherited EFFORT across a model change", () => {
      // `/model` changes the model; it does not restate the effort the session
      // was launched at, and the transcript never records effort — so dropping it
      // would silently demote a `:max` session to the model default.
      expect(reconcileRespawnModelSpec("claude-fable-5-1[1m]:max", SWITCHED_TO)).toBe(
        "claude-opus-5[1m]:max",
      );
    });

    it("returns null when the model has NOT changed, so an unchanged argv is untouched", () => {
      // The transcript records the bare id while the flag carries the decorated
      // spec; a raw string compare would report a change on every single respawn.
      expect(reconcileRespawnModelSpec("claude-opus-5[1m]:max", "claude-opus-5")).toBeNull();
    });

    it("does NOT convert an ALIAS pin into a version pin", () => {
      // A read-only probe over the live fleet caught this before it shipped: 4
      // running sessions carry `sonnet[1m]`, whose transcript resolves to
      // `claude-sonnet-5`. An exact-id compare calls that a change and rewrites
      // the flag — silently turning "latest sonnet" into "sonnet 5 forever".
      expect(reconcileRespawnModelSpec("sonnet[1m]", "claude-sonnet-5")).toBeNull();
      expect(reconcileRespawnModelSpec("opus:high", "claude-opus-5")).toBeNull();
    });

    it("does NOT chase a point release inside the same family", () => {
      // `claude-fable-5` resolving to `claude-fable-5-1` is the CLI picking the
      // current build, not the owner switching model.
      expect(reconcileRespawnModelSpec("claude-fable-5[1m]", "claude-fable-5-1")).toBeNull();
    });

    it("still acts on a real FAMILY change, which is what /model produces", () => {
      expect(reconcileRespawnModelSpec("sonnet[1m]", "claude-opus-5")).toBe("claude-opus-5[1m]");
      expect(reconcileRespawnModelSpec("claude-fable-5-1[1m]", "claude-haiku-5")).toBe(
        "claude-haiku-5",
      );
    });

    it("falls back to an exact compare when neither id has a known family", () => {
      // Provider-qualified / local ids are an open vocabulary — no family to read,
      // so identity is the only honest comparison.
      expect(
        reconcileRespawnModelSpec("openrouter/stealth/ox-alpha", "openrouter/stealth/ox-alpha"),
      ).toBeNull();
    });

    it("fails soft to the inherited spec on every uncertain input", () => {
      expect(reconcileRespawnModelSpec(null, SWITCHED_TO)).toBeNull(); // never ADD a flag
      expect(reconcileRespawnModelSpec(LAUNCHED, null)).toBeNull(); // nothing detected
      expect(reconcileRespawnModelSpec(LAUNCHED, "")).toBeNull();
      expect(reconcileRespawnModelSpec(LAUNCHED, "<synthetic>")).toBeNull(); // junk
    });
  });

  describe("modelSpecFromRecycleArgv", () => {
    it("reads both flag spellings, and reports absence as null", () => {
      expect(modelSpecFromRecycleArgv(["claude", "--model", LAUNCHED])).toBe(LAUNCHED);
      expect(modelSpecFromRecycleArgv(["claude", `--model=${LAUNCHED}`])).toBe(LAUNCHED);
      expect(modelSpecFromRecycleArgv(["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="xhigh"'])).toBe("gpt-5.6-sol:xhigh");
      expect(modelSpecFromRecycleArgv(["claude", "--session-id", UUID])).toBeNull();
    });
  });

  describe("mintRecycleArgs — the --model swap", () => {
    it("REPLACES the inherited --model with the session's current one", () => {
      // THE bug lived in the copy loop's bare `out.push(a)`, exactly as the P-002
      // persona staleness did. An explicit --model OVERRIDES the CLI's in-session
      // `/model` selection, so copying it through actively UNDOES the owner's switch.
      const { args } = mintRecycleArgs(
        ["claude", "--session-id", UUID, "--model", LAUNCHED, "--foo"],
        { mintId, agent: "claude", model: "claude-opus-5[1m]" },
      );
      expect(args).toEqual([
        "claude",
        "--session-id",
        FRESH,
        "--model",
        "claude-opus-5[1m]",
        "--foo",
      ]);
    });

    it("replaces the inline --model=<spec> spelling too", () => {
      const { args } = mintRecycleArgs(
        ["claude", "--session-id", UUID, `--model=${LAUNCHED}`],
        { mintId, agent: "claude", model: "claude-opus-5[1m]" },
      );
      expect(args).toEqual([
        "claude",
        "--session-id",
        FRESH,
        "--model=claude-opus-5[1m]",
      ]);
    });

    it("emits exactly ONE --model flag — never appends a second", () => {
      // claude takes the last one, but relying on that is an accident waiting to
      // be reordered.
      const { args } = mintRecycleArgs(
        ["claude", "--session-id", UUID, "--model", LAUNCHED],
        { mintId, agent: "claude", model: "claude-opus-5[1m]" },
      );
      expect(args.filter((a: string) => a.startsWith("--model")).length).toBe(1);
    });

    it("keeps the inherited spec when no current model was detected", () => {
      // Fail-soft: a stale model beats a successor booting on the wrong one.
      const { args } = mintRecycleArgs(
        ["claude", "--session-id", UUID, "--model", LAUNCHED],
        { mintId, agent: "claude", model: null },
      );
      expect(args).toEqual(["claude", "--session-id", FRESH, "--model", LAUNCHED]);
    });

    it("never ADDS a --model flag to an argv that had none", () => {
      // Such a session already honours `/model` across respawns on its own (the
      // CLI persists the selection and there is no flag to override it), so
      // adding one would newly pin a session that currently self-corrects.
      const { args } = mintRecycleArgs(["claude", "--session-id", UUID], {
        mintId,
        agent: "claude",
        model: "claude-opus-5[1m]",
      });
      expect(args).toEqual(["claude", "--session-id", FRESH]);
    });

    it("carry-respawn gets the swap from the same code path", () => {
      const { args } = mintCarryRespawnArgs(
        ["claude", "--session-id", UUID, "--model", LAUNCHED],
        {
          systemPromptAddendum: "# carry doc",
          ownerId: "su-wi2141859-test",
          mintId,
          agent: "claude",
          model: "claude-opus-5[1m]",
        },
      );
      expect(args).toContain("claude-opus-5[1m]");
      expect(args).not.toContain(LAUNCHED);
    });
  });

  describe("detectRespawnModelSpec", () => {
    const argv = ["claude", "--session-id", UUID, "--model", LAUNCHED];

    it("Codex home repair retains an unchanged explicit 6.1 model instead of requesting the saved default", () => {
      const previous = ["-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"'];
      const options = {
        agent: "codex", codexHome: join(tmpdir(), "codex-model-carry-test"),
        modelSource: "explicit", includeInherited: true,
        readLatestCodexRollout: () => ({ id: UUID }),
        readLastActiveModel: () => "gpt-6.1-sol:xhigh",
      };
      expect(detectRespawnModelSpec(previous, options)).toBe("gpt-6.1-sol:xhigh");
      // Ordinary argv rewriting still uses null to mean no change.
      expect(detectRespawnModelSpec(previous, { ...options, includeInherited: false })).toBeNull();
      expect(detectRespawnModelSpec(previous, {
        ...options, readLastActiveModel: () => null,
      })).toBe("gpt-6.1-sol:xhigh");
      expect(detectRespawnModelSpec([], options)).toBeNull();
    });

    it("Codex carry uses the repaired isolated-home model when the old launch model was still active", () => {
      const home = mkdtempSync(join(tmpdir(), "codex-model-carry-"));
      const codexHome = join(home, "isolated");
      mkdirSync(codexHome, { recursive: true });
      try {
        writeFileSync(join(codexHome, "config.toml"),
          'model = "gpt-6-sol"\nmodel_reasoning_effort = "xhigh"\n[mcp_servers.papercusp-su]\n');
        const previous = ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="xhigh"', "--dangerously-bypass-hook-trust"];
        const selected = detectRespawnModelSpec(previous, {
          agent: "codex",
          codexHome,
          advSessionId: 30870,
          modelSource: "configured-default",
          readLatestCodexRollout: () => ({ id: UUID }),
          readLastActiveModel: () => "gpt-5.6-sol",
        });
        expect(selected).toBe("gpt-6-sol:xhigh");
        const minted = mintRecycleArgs(previous, { agent: "codex", model: selected });
        expect(minted.args).toEqual(["-m", "gpt-6-sol", "-c", 'model_reasoning_effort="xhigh"', "--dangerously-bypass-hook-trust"]);
        expect(mintRecycleArgs(previous, { agent: "codex", model: "gpt-6-sol:high" }).args).toEqual(
          ["-m", "gpt-6-sol", "-c", 'model_reasoning_effort="high"', "--dangerously-bypass-hook-trust"],
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("Codex carry preserves an intentional in-session model switch over the home default", () => {
      const selected = detectRespawnModelSpec(["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="xhigh"'], {
        agent: "codex",
        codexHome: join(tmpdir(), "codex-model-carry-test"),
        modelSource: "configured-default",
        readLatestCodexRollout: () => ({ id: UUID }),
        readLastActiveModel: () => "gpt-6-sol",
      });
      expect(selected).toBe("gpt-6-sol:xhigh");
    });

    it("Codex carry keeps both the last selected Astra model and xhigh effort", () => {
      const previous = ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"'];
      const selected = detectRespawnModelSpec(previous, {
        agent: "codex",
        codexHome: join(tmpdir(), "codex-model-carry-test"),
        readLatestCodexRollout: () => ({ id: UUID }),
        readLastActiveModel: () => "gpt-6-astra:xhigh",
      });
      expect(selected).toBe("gpt-6-astra:xhigh");
      expect(mintRecycleArgs(previous, { agent: "codex", model: selected }).args).toEqual([
        "-m", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"',
      ]);
    });

    it("Codex carry keeps a reasoning change when the model name is unchanged", () => {
      const selected = detectRespawnModelSpec(
        ["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="medium"'],
        {
          agent: "codex",
          codexHome: join(tmpdir(), "codex-model-carry-test"),
          readLatestCodexRollout: () => ({ id: UUID }),
          readLastActiveModel: () => "gpt-6-astra:xhigh",
        },
      );
      expect(selected).toBe("gpt-6-astra:xhigh");
    });

    it.each(
      ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]
        .flatMap((model) => ["low", "medium", "high", "xhigh", "max"]
          .map((effort) => ({ model, effort }))),
    )("Codex carry preserves $model:$effort through argv minting", ({ model, effort }) => {
      const previous = ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"'];
      const selected = detectRespawnModelSpec(previous, {
        agent: "codex",
        codexHome: join(tmpdir(), "codex-model-carry-test"),
        readLatestCodexRollout: () => ({ id: UUID }),
        readLastActiveModel: () => `${model}:${effort}`,
      });
      const expected = model === "gpt-5.6-sol" && effort === "medium" ? null : `${model}:${effort}`;
      expect(selected).toBe(expected);
      const minted = mintRecycleArgs(previous, { agent: "codex", model: selected });
      expect(modelSpecFromRecycleArgv(minted.args)).toBe(expected ?? "gpt-5.6-sol:medium");
    });

    it("reads the session's own transcript and reports the switched-to model", () => {
      expect(
        detectRespawnModelSpec(argv, {
          ownerId: "su-x",
          agent: "claude",
          readLastActiveModel: () => SWITCHED_TO,
        }),
      ).toBe("claude-opus-5[1m]");
    });

    it("asks about the session named by the argv being replaced", () => {
      // The native id rotates on every respawn, so detection must read the CURRENT
      // child's transcript, not a remembered one.
      let asked: unknown = null;
      detectRespawnModelSpec(argv, {
        ownerId: "su-x",
        agent: "claude",
        readLastActiveModel: (session: { sessionId?: string }) => {
          asked = session.sessionId;
          return SWITCHED_TO;
        },
      });
      expect(asked).toBe(UUID);
    });

    it("returns null (keep inherited) when the transcript read throws", () => {
      expect(
        detectRespawnModelSpec(argv, {
          ownerId: "su-x",
          agent: "claude",
          readLastActiveModel: () => {
            throw new Error("unreadable");
          },
        }),
      ).toBeNull();
    });

    it("does not read a transcript at all when there is no --model to replace", () => {
      let called = false;
      const out = detectRespawnModelSpec(["claude", "--session-id", UUID], {
        ownerId: "su-x",
        agent: "claude",
        readLastActiveModel: () => {
          called = true;
          return SWITCHED_TO;
        },
      });
      expect(out).toBeNull();
      expect(called).toBe(false);
    });

    it("leaves an explicitly non-claude agent alone", () => {
      // codex/omp compose model flags differently; an empty agent still means the
      // claude argv shape, because the host passes an env var that can be unset.
      expect(
        detectRespawnModelSpec(argv, {
          agent: "omp",
          readLastActiveModel: () => SWITCHED_TO,
        }),
      ).toBeNull();
      expect(
        detectRespawnModelSpec(argv, {
          agent: undefined,
          readLastActiveModel: () => SWITCHED_TO,
        }),
      ).toBe("claude-opus-5[1m]");
    });
  });

  it("END TO END: the measured live regression no longer reproduces", () => {
    // su-60757119 on 2026-09-02 ran: fable, fable, fable, OPUS, FABLE, fable —
    // the owner's `/model opus` held for one session, then the respawn reverted it.
    // Detection + swap together are what stop the 5th hop going back to fable.
    const live = ["claude", "--session-id", UUID, "--model", LAUNCHED];
    const detected = detectRespawnModelSpec(live, {
      ownerId: "su-60757119-f49f-4207-a8e6-70505b6c463a",
      agent: "claude",
      readLastActiveModel: () => SWITCHED_TO, // what the transcript records post-/model
    });
    const { args } = mintRecycleArgs(live, { mintId, agent: "claude", model: detected });
    expect(args).toContain("claude-opus-5[1m]");
    expect(args).not.toContain(LAUNCHED);
  });
});

describe("mintRecycleArgs — personaFile swap (stale-prompt-render-in-live-sessions-2026-08-02 P-002)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  const FRESH = "ffffabcd-1234-5678-9abc-def012345678";
  const mintId = () => FRESH;
  const OLD_RENDER = "/home/u/.papercusp/launch-context/session-14416.md";
  const NEW_RENDER =
    "/home/u/.papercusp/launch-context/session-refresh-su-abc.md";

  it("REPLACES the inherited --system-prompt-file with the freshly re-rendered one", () => {
    // THE bug: the copy loop's bare `out.push(a)` carried the PREDECESSOR's render
    // through every respawn, pinning a session's base persona to launch #1 forever.
    // 27 of 53 live claude sessions were up to 14 days stale when measured.
    const { args } = mintRecycleArgs(
      [
        "claude",
        "--session-id",
        UUID,
        "--system-prompt-file",
        OLD_RENDER,
        "--foo",
      ],
      { mintId, personaFile: NEW_RENDER },
    );
    expect(args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      "--system-prompt-file",
      NEW_RENDER,
      "--foo",
    ]);
    // Replaced, not appended — exactly one occurrence, and the stale path is gone.
    expect(
      args.filter((a: string) => a === "--system-prompt-file"),
    ).toHaveLength(1);
    expect(args).not.toContain(OLD_RENDER);
  });

  it("replaces the --system-prompt-file=<path> form too", () => {
    const { args } = mintRecycleArgs(
      ["claude", "--session-id", UUID, `--system-prompt-file=${OLD_RENDER}`],
      { mintId, personaFile: NEW_RENDER },
    );
    expect(args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      `--system-prompt-file=${NEW_RENDER}`,
    ]);
  });

  it("KEEPS the inherited render when no personaFile is supplied (the fail-soft path)", () => {
    // A refresh that failed or was unavailable must never cost the session its
    // respawn — a stale prompt beats a dead session. This is also the pre-fix
    // behaviour, so it is the invariant a future change must not break.
    for (const persona of [null, undefined, "", "   "]) {
      const { args } = mintRecycleArgs(
        ["claude", "--session-id", UUID, "--system-prompt-file", OLD_RENDER],
        { mintId, personaFile: persona },
      );
      expect(args).toEqual([
        "claude",
        "--session-id",
        FRESH,
        "--system-prompt-file",
        OLD_RENDER,
      ]);
    }
  });

  it("never ADDS --system-prompt-file for a non-claude (or unnamed) agent, and never touches --append-system-prompt-file", () => {
    // omp/codex do not take --system-prompt-file; injecting one would be a new flag
    // on a backend that never asked for it. And the APPEND flag carries the carry
    // document + the launch brief — swapping that would drop the session's mission.
    const carry = "/home/u/.papercusp/launch-context/carry-su-abc.md";
    const { args } = mintRecycleArgs(
      ["claude", "--session-id", UUID, "--append-system-prompt-file", carry],
      { mintId, personaFile: NEW_RENDER },
    );
    expect(args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      "--append-system-prompt-file",
      carry,
    ]);
    expect(args).not.toContain(NEW_RENDER);
  });
});

describe("a resumed claude process keeps its persona across /clear and respawn (EI-24628537598753105)", () => {
  const FRESH = "ffffabcd-1234-5678-9abc-def012345678";
  const mintId = () => FRESH;
  const RENDER = "/home/u/.papercusp/launch-context/session-refresh-su-abc.md";
  const RESUMED = "ebe4d65d-bb40-43af-86a9-35a9446fed37";
  const persona = (args: string[]) => {
    const i = args.indexOf("--system-prompt-file");
    return i >= 0 ? args[i + 1] : null;
  };

  it("resumeArgsFor puts the fresh render in the claude resume argv, with the same flags as a fresh SU launch", () => {
    // Measured 2026-09-29 (su-89238d16): `psu --resume` ran `claude --resume <id>`
    // with no persona flag; the cold-auto /clear then opened native 8506ff77 on
    // claude's 6,312-char stock prompt instead of the 181K playbook.
    const { args } = resumeArgsFor(
      { agent: "claude", cwd: "/x", sessionId: RESUMED },
      { personaFile: RENDER },
    );
    expect(args.slice(0, 2)).toEqual(["--resume", RESUMED]);
    expect(persona(args)).toBe(RENDER);
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
  });

  it("resumeArgsFor without a render keeps the old argv (fail-soft)", () => {
    for (const personaFile of [null, undefined]) {
      const { args } = resumeArgsFor(
        { agent: "claude", cwd: "/x", sessionId: RESUMED },
        { personaFile },
      );
      expect(args).not.toContain("--system-prompt-file");
      expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
    }
  });

  it("mintRecycleArgs ADDS the render to a claude argv that has none (a pre-fix resumed process heals on its next respawn)", () => {
    const carry = "/home/u/.papercusp/launch-context/carry-su-abc.md";
    const { args, nativeId } = mintRecycleArgs(
      ["--resume", RESUMED, "--dangerously-skip-permissions", "--append-system-prompt-file", carry],
      { mintId, agent: "claude", personaFile: RENDER },
    );
    expect(nativeId).toBe(FRESH);
    expect(args).not.toContain("--resume");
    expect(args).not.toContain(RESUMED);
    expect(persona(args)).toBe(RENDER);
    expect(args.filter((a: string) => a === "--system-prompt-file")).toHaveLength(1);
    expect(args.filter((a: string) => a === "--exclude-dynamic-system-prompt-sections")).toHaveLength(1);
    // The carry document is untouched.
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe(carry);
  });

  it("mintRecycleArgs adds nothing to a claude argv without a render", () => {
    const { args } = mintRecycleArgs(["--resume", RESUMED], {
      mintId,
      agent: "claude",
      personaFile: null,
    });
    expect(args).toEqual(["--session-id", FRESH]);
  });

  it("mintRecycleArgs does not duplicate --exclude-dynamic-system-prompt-sections already in argv", () => {
    const { args } = mintRecycleArgs(
      ["--resume", RESUMED, "--exclude-dynamic-system-prompt-sections"],
      { mintId, agent: "claude", personaFile: RENDER },
    );
    expect(args.filter((a: string) => a === "--exclude-dynamic-system-prompt-sections")).toHaveLength(1);
    expect(persona(args)).toBe(RENDER);
  });
});

describe("kickoff positional is dropped on respawn (WI-37939)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  const FRESH = "ffffabcd-1234-5678-9abc-def012345678";
  const mintId = () => FRESH;
  // The REAL kickoff recovered from su-12b70e95's persisted argv (args[12]) — a
  // fleet-kickoff minted 2026-08-10T16:57:23Z and still being re-delivered 26.6h
  // later, which is how this bug was found.
  const KICKOFF =
    "⟦turn-origin:fleet-kickoff nonce:2299b27f74c65c6b⟧\n" +
    "You are in GOAL mode on goal `make-a-website-displaying-images-of-pandas-aa0205`, which the owner just started.";

  it("drops the tagged kickoff positional, so the successor does not re-open on it", () => {
    // THE bug: the copy loop's bare `out.push(a)` carried the launch prompt through
    // every respawn, so each fresh child re-exec'd claude with the ORIGINAL kickoff
    // still on argv and opened on it as turn 1 — 26.6h stale, asserting a GOAL-mode
    // contract the session never held, for an already-achieved goal.
    const { args } = mintRecycleArgs(
      [
        "claude",
        "--session-id",
        UUID,
        "--disallowedTools=Task,Agent,Workflow",
        KICKOFF,
      ],
      { mintId, agent: "claude" },
    );
    expect(args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      "--disallowedTools=Task,Agent,Workflow",
    ]);
    expect(args.some((a: string) => a.includes("turn-origin"))).toBe(false);
  });

  it("drops an UNTAGGED kickoff behind an inline --key=value (tagKickoffProvenance is fail-soft)", () => {
    // tagKickoffProvenance returns the text UNTAGGED on any error, so the envelope
    // cannot be the only signal. An inline `--key=value` owns no following token,
    // which makes what follows it a provable positional.
    const { args } = mintRecycleArgs(
      [
        "claude",
        "--session-id",
        UUID,
        "--disallowedTools=Task",
        "start by working plan foo",
      ],
      { mintId, agent: "claude" },
    );
    expect(args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      "--disallowedTools=Task",
    ]);
  });

  it("NEVER eats a flag VALUE — the safety invariant that outranks the fix", () => {
    // Wrongly stripping a value launches the successor with a broken flag, which is
    // strictly worse than the staleness being fixed. A trailing token owned by a
    // value-taking flag must survive untouched.
    for (const tail of [
      ["--permission-mode", "bypassPermissions"],
      [
        "--system-prompt-file",
        "/home/u/.papercusp/launch-context/session-14710.md",
      ],
      ["--settings", '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9073"}}'],
      ["--add-dir", "/some/dir"],
    ]) {
      const { args } = mintRecycleArgs(
        ["claude", "--session-id", UUID, ...tail],
        {
          mintId,
          agent: "claude",
        },
      );
      expect(args).toEqual(["claude", "--session-id", FRESH, ...tail]);
    }
  });

  it("leaves an argv that never had a kickoff completely alone", () => {
    const src = [
      "claude",
      "--session-id",
      UUID,
      "--dangerously-skip-permissions",
    ];
    const { args } = mintRecycleArgs(src, { mintId, agent: "claude" });
    expect(args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      "--dangerously-skip-permissions",
    ]);
  });

  it("is idempotent — a second respawn of an already-stripped argv is a no-op", () => {
    // Respawn chains are long-lived (this session respawned 6+ times in 27h); the
    // strip must not drift the argv further on each hop.
    const first = mintRecycleArgs(
      ["claude", "--session-id", UUID, "--disallowedTools=Task", KICKOFF],
      { mintId, agent: "claude" },
    ).args;
    const second = mintRecycleArgs(first, { mintId, agent: "claude" }).args;
    expect(second).toEqual(first);
  });

  it("carry-respawn drops it too, and still ends on the carry document", () => {
    // mintCarryRespawnArgs delegates to mintRecycleArgs, so BOTH respawn modes get
    // the fix from one code path (same shape as the P-002 persona swap above).
    const { args } = mintCarryRespawnArgs(
      ["claude", "--session-id", UUID, "--disallowedTools=Task", KICKOFF],
      {
        systemPromptAddendum: "# carry doc",
        ownerId: "su-wi37939-test",
        mintId,
        agent: "claude",
      },
    );
    expect(args.some((a: string) => a.includes("turn-origin"))).toBe(false);
    expect(args[args.length - 2]).toBe("--append-system-prompt-file");
  });

  it("stripKickoffPositional: falsifiable on the exact token classes it decides between", () => {
    // A guard that has never failed is untested — pin BOTH verdicts, not just the
    // strip, so a future loosening that eats values fails here.
    expect(stripKickoffPositional(["claude", "--a=b", KICKOFF])).toEqual([
      "claude",
      "--a=b",
    ]);
    expect(stripKickoffPositional(["claude", "--a=b", "positional"])).toEqual([
      "claude",
      "--a=b",
    ]);
    // Value-taking flag → the token is a VALUE, not a positional: untouched.
    expect(stripKickoffPositional(["claude", "--flag", "value"])).toEqual([
      "claude",
      "--flag",
      "value",
    ]);
    // No trailing positional at all.
    expect(stripKickoffPositional(["claude", "--x"])).toEqual([
      "claude",
      "--x",
    ]);
    expect(stripKickoffPositional([])).toEqual([]);
  });
});

describe("mintCarryRespawnArgs (P-018 deterministic successor launch context)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  const FRESH = "ffffabcd-1234-5678-9abc-def012345678";
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-carry-respawn-"));
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("rotates the native id and layers one 0600 cut-scoped carry file", () => {
    const out = mintCarryRespawnArgs(
      ["claude", "--session-id", UUID, "--foo"],
      {
        systemPromptAddendum: "deterministic carry body",
        ownerId: "su/test owner",
        mintId: () => FRESH,
        home,
      },
    );
    expect(out.nativeId).toBe(FRESH);
    expect(out.launchContextPath).toBe(
      join(
        home,
        ".papercusp",
        "launch-context",
        `carry-su_test_owner-${FRESH}.md`,
      ),
    );
    expect(out.args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      "--foo",
      "--append-system-prompt-file",
      out.launchContextPath,
    ]);
    expect(readFileSync(out.launchContextPath, "utf8")).toBe(
      "deterministic carry body\n",
    );
    expect(statSync(out.launchContextPath).mode & 0o777).toBe(0o600);
  });

  // WI-10002026: the reported failure is a successor handed the PREVIOUS
  // generation's carry document, discarding an entire intervening session's
  // turns while the embedded recovery marker still asserted complete:true.
  // The structural precondition for that is a SHARED mutable delivery slot —
  // one `carry-<ownerId>.md` overwritten in place by every cut of that owner,
  // read by the successor BY PATH at boot. Binding the freshly-minted native id
  // into the name removes the precondition: a cut's document is unreachable by
  // any other cut's successor. Asserting the paths merely differ is too weak —
  // it passes for a slot that is renamed but still clobbered — so this asserts
  // the earlier cut's CONTENT survives the later cut verbatim.
  it("gives each cut its own carry file, so a later cut cannot overwrite an earlier cut's document", () => {
    const FIRST_CUT = "aaaa1111-1234-5678-9abc-def012345678";
    const SECOND_CUT = "bbbb2222-1234-5678-9abc-def012345678";
    const owner = "su-shared-owner";

    const first = mintCarryRespawnArgs(["claude", "--session-id", UUID], {
      systemPromptAddendum: "GENERATION ONE document",
      ownerId: owner,
      mintId: () => FIRST_CUT,
      home,
    });
    const second = mintCarryRespawnArgs(["claude", "--session-id", FIRST_CUT], {
      systemPromptAddendum: "GENERATION TWO document",
      ownerId: owner,
      mintId: () => SECOND_CUT,
      home,
    });

    expect(first.launchContextPath).not.toBe(second.launchContextPath);
    // The successor reads its carry by the path it was launched with, so each
    // path must still resolve to the document built for THAT cut.
    expect(readFileSync(first.launchContextPath, "utf8")).toBe(
      "GENERATION ONE document\n",
    );
    expect(readFileSync(second.launchContextPath, "utf8")).toBe(
      "GENERATION TWO document\n",
    );
    // Each cut's successor is launched with its OWN path, never a shared one.
    expect(first.args).toContain(first.launchContextPath);
    expect(second.args).toContain(second.launchContextPath);
    expect(second.args).not.toContain(first.launchContextPath);
  });

  it("writes the carry file atomically, leaving no partial temp render behind", () => {
    const out = mintCarryRespawnArgs(["claude", "--session-id", UUID], {
      systemPromptAddendum: "atomic carry body",
      ownerId: "su-atomic",
      mintId: () => FRESH,
      home,
    });
    expect(readFileSync(out.launchContextPath, "utf8")).toBe(
      "atomic carry body\n",
    );
    // A plain in-place writeFileSync truncates before it writes, so a successor
    // booting mid-write reads a TRUNCATED document that presents as a
    // short-but-valid one. tmp+rename makes the swap atomic; assert the temp
    // render is not left behind (and so can never be mistaken for a carry).
    const dir = join(home, ".papercusp", "launch-context");
    expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("threads personaFile through to the base-prompt swap while still layering the carry (P-002)", () => {
    // The two prompt files answer different questions and must BOTH be right on a
    // carry-respawn: --system-prompt-file is the base persona (which went stale) and
    // --append-system-prompt-file is this cut's carry document (which never did).
    // Fixing one by clobbering the other would trade a stale prompt for a lost
    // hand-off, so assert them together.
    const stale = join(
      home,
      ".papercusp",
      "launch-context",
      "session-14416.md",
    );
    const fresh = join(
      home,
      ".papercusp",
      "launch-context",
      "session-refresh-su_test_owner.md",
    );
    const out = mintCarryRespawnArgs(
      ["claude", "--session-id", UUID, "--system-prompt-file", stale],
      {
        systemPromptAddendum: "carry body",
        ownerId: "su/test owner",
        mintId: () => FRESH,
        home,
        personaFile: fresh,
      },
    );
    expect(out.args).toEqual([
      "claude",
      "--session-id",
      FRESH,
      "--system-prompt-file",
      fresh,
      "--append-system-prompt-file",
      out.launchContextPath,
    ]);
    expect(out.args).not.toContain(stale);
  });

  it("fails before any respawn when the carry is empty or the agent has no managed carry consumer", () => {
    expect(() =>
      mintCarryRespawnArgs(["claude", "--session-id", UUID], {
        systemPromptAddendum: "  ",
        home,
      }),
    ).toThrow(/non-empty/);
    // OMP has no managed carry consumer. Codex is covered separately below.
    expect(() =>
      mintCarryRespawnArgs(["omp"], {
        systemPromptAddendum: "carry",
        home,
        agent: "omp",
      }),
    ).toThrow(/Claude and Codex/);
  });

  it("restarts Codex as a fresh thread with one full carry and an AGENTS recovery pointer", () => {
    const codexHome = join(home, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "AGENTS.md"), "# Base persona\n", {
      mode: 0o600,
    });
    const kickoff =
      "⟦turn-origin:fleet-kickoff nonce:12345678⟧\nBegin draining.";

    const first = mintCarryRespawnArgs(
      ["--dangerously-bypass-hook-trust", "-m", "gpt-5.6-luna", kickoff],
      {
        systemPromptAddendum: "first deterministic carry",
        ownerId: "su-codex-carry",
        home,
        agent: "codex",
        codexHome,
      },
    );
    expect(first.nativeId).toBeNull();
    expect(first.args).toEqual([
      "--dangerously-bypass-hook-trust",
      "-m",
      "gpt-5.6-luna",
    ]);
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).not.toContain("first deterministic carry");
    expect(first.carryText).toContain("first deterministic carry");
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toContain(first.launchContextPath);
    expect(
      readFileSync(join(codexHome, ".papercusp-carry-base-AGENTS.md"), "utf8"),
    ).toBe("# Base persona\n");
    expect(statSync(join(codexHome, "AGENTS.md")).mode & 0o777).toBe(0o600);

    const second = mintCarryRespawnArgs(
      ["--dangerously-bypass-hook-trust", "-m", "gpt-5.6-luna", "resume", UUID],
      {
        systemPromptAddendum: "second deterministic carry",
        ownerId: "su-codex-carry",
        home,
        agent: "codex",
        codexHome,
      },
    );
    expect(second.args).toEqual([
      "--dangerously-bypass-hook-trust",
      "-m",
      "gpt-5.6-luna",
    ]);
    const agents = readFileSync(join(codexHome, "AGENTS.md"), "utf8");
    expect(agents).toContain("# Base persona");
    expect(agents).not.toContain("second deterministic carry");
    expect(second.carryText).toContain("second deterministic carry");
    expect(agents).toContain(second.launchContextPath);
    expect(agents).not.toContain("first deterministic carry");
  });

  it.each([{ inheritedArgs: [] }, { inheritedArgs: ["resume", UUID] }, { inheritedArgs: ["fork", UUID] }])("starts a compact managed Codex successor without inheriting history ($inheritedArgs)", ({ inheritedArgs }) => {
    const codexHome = join(home, "codex-home");
    const sessions = join(codexHome, "sessions", "2026", "09", "21");
    mkdirSync(sessions, { recursive: true });
    const predecessor = "0123abcd-1234-5678-9abc-def012345678";
    const rollout = join(sessions, `rollout-2026-09-21T12-00-00-${predecessor}.jsonl`);
    const predecessorText = '{"type":"event_msg","payload":{"type":"task_complete"}}\n';
    writeFileSync(rollout, predecessorText, { mode: 0o600 });
    writeFileSync(join(codexHome, "AGENTS.md"), "# Base persona\n", { mode: 0o600 });

    expect(latestCodexRollout(join(codexHome, "sessions"))).toMatchObject({
      id: predecessor,
      path: rollout,
    });
    const out = mintCarryRespawnArgs(
      ["--dangerously-bypass-hook-trust", "-m", "gpt-5.6-luna", ...inheritedArgs],
      {
        systemPromptAddendum: "successor carry",
        ownerId: "su-codex-lineage",
        home,
        agent: "codex",
        codexHome,
      },
    );

    expect(out.nativeId).toBeNull();
    expect(out.args).toEqual([
      "--dangerously-bypass-hook-trust",
      "-m",
      "gpt-5.6-luna",
    ]);
    expect(out.predecessorSessionId).toBe(predecessor);
    expect(readFileSync(out.launchContextPath, "utf8")).toContain(
      codexCarryLineageMarker(predecessor),
    );
    expect(out.carryText).toContain(`predecessor:${predecessor}`);
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toContain(out.launchContextPath);
    expect(JSON.parse(readFileSync(out.lineagePath, "utf8"))).toMatchObject({
      predecessorSessionId: predecessor,
      successorMode: "fresh",
      predecessorPath: rollout,
      carryPath: out.launchContextPath,
    });
    // Recovery links remain available without feeding the entire predecessor
    // back into the model. An explicit user fork is tested separately above.
    expect(readFileSync(rollout, "utf8")).toBe(predecessorText);
    expect(out.carryText).not.toContain("available above");
    expect(out.carryText).toContain("sessions:read");
  });

  it("preserves large-carry continuity and exact recovery without copying predecessor history into context", () => {
    const codexHome = join(home, "codex-large-carry");
    const sessions = join(codexHome, "sessions", "2026", "09", "21");
    mkdirSync(sessions, { recursive: true });
    const predecessor = "0123abcd-1234-5678-9abc-def012345678";
    const rollout = join(sessions, `rollout-2026-09-21T12-00-00-${predecessor}.jsonl`);
    const history = JSON.stringify({ type: "response_item", payload: { text: "old history ".repeat(100000) } }) + "\n";
    writeFileSync(rollout, history, { mode: 0o600 });
    const base = "# Required instructions\nNever cross an authorization boundary.\n";
    writeFileSync(join(codexHome, "AGENTS.md"), base, { mode: 0o600 });
    const continuity = [
      "# Carry document",
      "Pending owner directive: finish the existing task; route:self.",
      "Work item: WI-example. Decision: preserve the approved approach.",
      "Evidence: exact request ledger reference. Unknown: provider cache expiry.",
      "Next: verify the pending test result before repeating any action.",
      "saved evidence\n".repeat(5000).trimEnd(),
    ].join("\n\n");
    const out = mintCarryRespawnArgs(["--dangerously-bypass-hook-trust", "fork", predecessor], {
      systemPromptAddendum: continuity,
      ownerId: "su-large-carry",
      home,
      agent: "codex",
      codexHome,
    });
    const agents = readFileSync(join(codexHome, "AGENTS.md"), "utf8");
    expect(agents.startsWith(base)).toBe(true);
    expect(agents).toContain(out.launchContextPath);
    expect(agents).not.toContain(continuity);
    expect(out.carryText).toContain(continuity);
    expect(out.carryText).toContain(codexCarryLineageMarker(predecessor));
    expect(readFileSync(out.launchContextPath, "utf8")).toBe(`${out.carryText}\n`);
    expect(readFileSync(rollout, "utf8")).toBe(history);
    expect(out.args).toEqual(["--dangerously-bypass-hook-trust"]);
    expect(agents + out.carryText).not.toContain("old history ");
    expect((agents + out.carryText).split("# Carry document")).toHaveLength(2);
  });

  it("uses an unresolved lineage marker and a blank-thread fallback when no Codex rollout exists", () => {
    const codexHome = join(home, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "AGENTS.md"), "# Base persona\n", { mode: 0o600 });
    const out = mintCarryRespawnArgs(["--dangerously-bypass-hook-trust"], {
      systemPromptAddendum: "successor carry",
      ownerId: "su-codex-no-predecessor",
      home,
      agent: "codex",
      codexHome,
    });

    expect(out.args).toEqual(["--dangerously-bypass-hook-trust"]);
    expect(out.predecessorSessionId).toBeNull();
    expect(readFileSync(out.launchContextPath, "utf8")).toContain(
      codexCarryLineageMarker(null),
    );
    expect(JSON.parse(readFileSync(out.lineagePath, "utf8"))).toMatchObject({
      predecessorSessionId: null,
      successorMode: "fresh",
    });
  });

  it("refuses a carry with no restored SU instructions", () => {
    const codexHome = join(home, "codex-home");
    mkdirSync(codexHome, { recursive: true });

    expect(() => mintCarryRespawnArgs(["--dangerously-bypass-hook-trust"], {
      systemPromptAddendum: "recovered carry",
      ownerId: "su-codex-missing-agents",
      home,
      agent: "codex",
      codexHome,
    })).toThrow(/restored non-empty AGENTS\.md base/);
    expect(existsSync(join(codexHome, "AGENTS.md"))).toBe(false);
  });

  it.each([
    ["legacy AGENTS.md without a base snapshot", false],
    ["legacy contaminated base snapshot", true],
  ])("repairs %s before layering the next carry", (_label, hasBaseSnapshot) => {
    const codexHome = join(home, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const legacyAgents = [
      "# Base persona",
      "",
      "---",
      "## Managed carry checkpoint",
      "",
      "stale carry from a predecessor",
      "",
    ].join("\n");
    writeFileSync(join(codexHome, "AGENTS.md"), legacyAgents, { mode: 0o600 });
    if (hasBaseSnapshot) {
      writeFileSync(
        join(codexHome, ".papercusp-carry-base-AGENTS.md"),
        legacyAgents,
        { mode: 0o600 },
      );
    }

    const out = mintCarryRespawnArgs(
      ["--dangerously-bypass-hook-trust", "-m", "gpt-5.6-luna"],
      {
        systemPromptAddendum: "fresh carry after repair",
        ownerId: "su-codex-legacy-carry",
        home,
        agent: "codex",
        codexHome,
      },
    );

    const agents = readFileSync(join(codexHome, "AGENTS.md"), "utf8");
    const base = readFileSync(
      join(codexHome, ".papercusp-carry-base-AGENTS.md"),
      "utf8",
    );
    expect(base).toBe("# Base persona\n");
    expect(agents).toContain("# Base persona");
    expect(agents).not.toContain("fresh carry after repair");
    expect(out.carryText).toContain("fresh carry after repair");
    expect(agents).toContain(out.launchContextPath);
    expect(agents).not.toContain("stale carry from a predecessor");
    expect(agents.match(/^## Managed carry checkpoint$/gm) ?? []).toHaveLength(
      1,
    );
  });

  it("mints a successor for a RESUME-launched claude argv (no --session-id to rotate — synthesized)", () => {
    // The owner-reported 2026-07-18 spam: `psu --resume` sessions could never be
    // force-respawned because this threw on their `claude --resume <id>` argv.
    const out = mintCarryRespawnArgs(["claude", "--resume", UUID, "--foo"], {
      systemPromptAddendum: "deterministic carry body",
      ownerId: "su-resumed",
      mintId: () => FRESH,
      home,
    });
    expect(out.nativeId).toBe(FRESH);
    expect(out.args).toEqual([
      "claude",
      "--foo",
      "--session-id",
      FRESH,
      "--append-system-prompt-file",
      out.launchContextPath,
    ]);
    expect(out.args).not.toContain(UUID);
  });
});

describe("claudeStoreHasSession (check if claude can resume a specific session)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-stores-"));
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("returns true when Claude store has the session file", () => {
    const projDir = join(home, ".claude", "projects", "-some-dir");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it("returns true even if the session file is empty", () => {
    const projDir = join(home, ".claude", "projects", "my-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), "");
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it("searches across multiple project directories", () => {
    // Create session in a different project dir
    const projDir = join(home, ".claude", "projects", "-other-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it("returns false when the session file does not exist", () => {
    mkdirSync(join(home, ".claude", "projects", "my-proj"), {
      recursive: true,
    });
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it("returns false for null or undefined ids", () => {
    mkdirSync(join(home, ".claude", "projects", "my-proj"), {
      recursive: true,
    });
    expect(claudeStoreHasSession(null, { home })).toBe(false);
    expect(claudeStoreHasSession(undefined, { home })).toBe(false);
    expect(claudeStoreHasSession("", { home })).toBe(false);
  });

  it("returns false when .claude/projects does not exist", () => {
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it("EI-155: finds the transcript in the isolated configDir (not the shared store)", () => {
    // The transcript exists ONLY in the per-session isolated config dir.
    const configDir = join(home, ".papercusp", "session-claude", "su-owner-2");
    const projDir = join(configDir, "projects", "-iso");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    // Without the configDir hint, the shared store has nothing → false…
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
    // …with it, the brain transcript-check finds the isolated session → true.
    expect(claudeStoreHasSession(UUID, { home, configDir })).toBe(true);
  });
});

describe("claudeStoreHasSession (a tracked adv row alone does not prove resumability)", () => {
  const UUID = "0c0f59c1-1706-4244-aefc-3d6f0aee2361";
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-brain-"));
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("true when the transcript exists in any project dir", () => {
    const projDir = join(home, ".claude", "projects", "-some-dir");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, `${UUID}.jsonl`),
      `{"sessionId":"${UUID}","cwd":"/x"}\n`,
    );
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it("false when no transcript exists — the brain-pane wedge case: a pinned + adv-tracked session whose launch died before its first turn", () => {
    mkdirSync(join(home, ".claude", "projects", "-some-dir"), {
      recursive: true,
    });
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it("false for a missing store dir or empty id", () => {
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
    expect(claudeStoreHasSession("", { home })).toBe(false);
  });
});

describe("rehealResumeCredentials (WI-4727 — psu --resume re-login: heal the stale isolated .credentials.json fork)", () => {
  // The regression: `psu --resume <id>` prompts a Claude LOGIN despite the owner
  // being logged in on the default account. Root cause — each psu session runs
  // claude in an ISOLATED CLAUDE_CONFIG_DIR; claude REPLACES .credentials.json on
  // every OAuth refresh (temp+rename), swapping the symlink-to-global for a
  // divergent real-file fork. Anthropic's single-use rotating refresh tokens then
  // make that fork go stale the moment the global rotates. rehealResumeCredentials
  // re-establishes the fresh-mirror invariant before a resume spawn: the isolated
  // .credentials.json must end up a SYMLINK to the (reconciler-kept-newest) global.
  let home = "";
  let configDir = "";
  const globalOf = () => join(home, ".claude", ".credentials.json");
  const sessOf = () => join(configDir, ".credentials.json");
  const credBundle = (expiresAt: number, accessToken = "tok") =>
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
  const writeGlobal = (expiresAt: number, accessToken = "global-tok") => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(globalOf(), credBundle(expiresAt, accessToken));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-reheal-"));
    configDir = join(home, ".papercusp", "session-claude", "su-owner-1");
    mkdirSync(configDir, { recursive: true });
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("a stale REAL-FILE session fork is replaced by a SYMLINK to the live global (the owner-reported regression)", () => {
    writeGlobal(9_000, "live-global-token");
    // The divergent, stale real-file fork left behind by an in-session refresh.
    writeFileSync(sessOf(), credBundle(1_000, "stale-fork-token"));
    expect(lstatSync(sessOf()).isSymbolicLink()).toBe(false); // precondition: real file

    rehealResumeCredentials(configDir, { home });

    // Post: the session credential is now a symlink resolving to the global CLI login…
    expect(lstatSync(sessOf()).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessOf())).toBe(realpathSync(globalOf()));
    // …so claude follows it to the live token, never the stale fork.
    expect(
      JSON.parse(readFileSync(sessOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("live-global-token");
    // The global's newer bundle is untouched (the fork was OLDER — not promoted).
    expect(
      JSON.parse(readFileSync(globalOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("live-global-token");
  });

  it("promotes a strictly-NEWER real-file fork to the global, THEN symlinks the session at it", () => {
    // An in-session refresh the background reconciler has not converged yet: the
    // isolated fork holds a bundle newer than the global. Promote-then-mirror so the
    // canonical global carries the newest bundle before we re-point the session.
    writeGlobal(1_000, "older-global-token");
    writeFileSync(sessOf(), credBundle(9_000, "newer-fork-token"));

    rehealResumeCredentials(configDir, { home });

    // The newer fork was promoted into the global…
    expect(
      JSON.parse(readFileSync(globalOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("newer-fork-token");
    expect(claudeCredExpiresAt(globalOf())).toBe(9_000);
    // …and the session credential is a symlink resolving to that now-newest global.
    expect(lstatSync(sessOf()).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessOf())).toBe(realpathSync(globalOf()));
    expect(
      JSON.parse(readFileSync(sessOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("newer-fork-token");
  });

  it("promotes the newest fork from a DIFFERENT concurrent session (fleet-wide sweep, not just this session vs global — WI-4727 durability follow-up)", () => {
    // The gap the original pairwise (this-session-vs-global) reheal missed:
    // resuming su-owner-1 while su-owner-2 — a DIFFERENT live session — holds
    // the truly newest bundle (its own in-session refresh the background
    // reconciler hasn't converged yet). su-owner-1's own fork is merely
    // stale, not the oldest, so a narrow check would symlink it straight to
    // the (also-stale) global and miss the fresher token entirely.
    writeGlobal(1_000, "stale-global-token");
    writeFileSync(sessOf(), credBundle(2_000, "this-session-token")); // newer than global, but NOT the newest
    const otherSessionDir = join(
      home,
      ".papercusp",
      "session-claude",
      "su-owner-2",
    );
    mkdirSync(otherSessionDir, { recursive: true });
    writeFileSync(
      join(otherSessionDir, ".credentials.json"),
      credBundle(9_000, "other-session-newest-token"),
    );

    rehealResumeCredentials(configDir, { home });

    // The global was promoted to the true fleet-wide newest (su-owner-2's fork)…
    expect(
      JSON.parse(readFileSync(globalOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("other-session-newest-token");
    expect(claudeCredExpiresAt(globalOf())).toBe(9_000);
    // …and su-owner-1 (the one actually resuming) symlinks to that promoted global.
    expect(lstatSync(sessOf()).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessOf())).toBe(realpathSync(globalOf()));
    expect(
      JSON.parse(readFileSync(sessOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("other-session-newest-token");
    // The other (non-resuming) session's fork is untouched — promotion reads it, never mutates it.
    expect(
      lstatSync(join(otherSessionDir, ".credentials.json")).isSymbolicLink(),
    ).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(otherSessionDir, ".credentials.json"), "utf8"),
      ).claudeAiOauth.accessToken,
    ).toBe("other-session-newest-token");
  });

  it("a SYMLINKED fork under the session root is skipped by the sweep (it already resolves to the global; nothing to promote from it)", () => {
    writeGlobal(5_000, "global-token");
    writeFileSync(sessOf(), credBundle(1_000, "stale-this-session"));
    const otherSessionDir = join(
      home,
      ".papercusp",
      "session-claude",
      "su-owner-3",
    );
    mkdirSync(otherSessionDir, { recursive: true });
    // su-owner-3 is already a healthy symlink → global: the sweep must not
    // treat the file IT RESOLVES TO as if it were su-owner-3's own bundle.
    symlinkSync(globalOf(), join(otherSessionDir, ".credentials.json"));

    rehealResumeCredentials(configDir, { home });

    // Global stays exactly what it was — no fork had a newer bundle to promote.
    expect(
      JSON.parse(readFileSync(globalOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("global-token");
    expect(lstatSync(sessOf()).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessOf())).toBe(realpathSync(globalOf()));
  });

  it("leaves a HEALTHY symlink (already resolving to the global) byte-identical", () => {
    writeGlobal(5_000, "healthy-token");
    symlinkSync(globalOf(), sessOf());
    const before = lstatSync(sessOf());

    rehealResumeCredentials(configDir, { home });

    expect(lstatSync(sessOf()).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessOf())).toBe(realpathSync(globalOf()));
    // Untouched — same inode / mtime (not rm+re-symlinked).
    expect(lstatSync(sessOf()).ino).toBe(before.ino);
    expect(lstatSync(sessOf()).mtimeMs).toBe(before.mtimeMs);
  });

  it("re-heals a DANGLING session symlink (points at a now-deleted path) into a live symlink", () => {
    writeGlobal(5_000, "live-token");
    symlinkSync(join(home, ".claude", "gone.json"), sessOf()); // dangling
    expect(existsSync(sessOf())).toBe(false); // dangling target

    rehealResumeCredentials(configDir, { home });

    expect(lstatSync(sessOf()).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessOf())).toBe(realpathSync(globalOf()));
    expect(
      JSON.parse(readFileSync(sessOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("live-token");
  });

  it("no global credential → no-op (API-key-only / fresh box: nothing to mirror)", () => {
    // No global written. A pre-existing session fork must NOT be clobbered when
    // there is no canonical login to mirror from.
    writeFileSync(sessOf(), credBundle(1_000, "only-fork"));
    rehealResumeCredentials(configDir, { home });
    expect(existsSync(globalOf())).toBe(false);
    expect(lstatSync(sessOf()).isSymbolicLink()).toBe(false); // left as-is
    expect(
      JSON.parse(readFileSync(sessOf(), "utf8")).claudeAiOauth.accessToken,
    ).toBe("only-fork");
  });

  it("never throws — a launch must survive credential reconciliation failure (empty configDir)", () => {
    writeGlobal(5_000);
    expect(() => rehealResumeCredentials("", { home })).not.toThrow();
    expect(() =>
      rehealResumeCredentials(undefined as unknown as string, { home }),
    ).not.toThrow();
  });
});

describe("rehealResumeCodexAuth — default-account exact resumes reuse the system login", () => {
  let home = "";
  let codexHome = "";
  const globalOf = () => join(home, ".codex", "auth.json");
  const sessionOf = () => join(codexHome, "auth.json");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-codex-auth-reheal-"));
    codexHome = join(home, ".papercusp", "su-codex-homes", "session-42");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("adds the missing auth symlink when the isolated home predates the system login", () => {
    writeFileSync(globalOf(), '{"auth_mode":"chatgpt"}');
    expect(existsSync(sessionOf())).toBe(false);

    rehealResumeCodexAuth(codexHome, { home });

    expect(lstatSync(sessionOf()).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessionOf())).toBe(realpathSync(globalOf()));
  });

  it("replaces a stale isolated auth file with the explicit default system login", () => {
    writeFileSync(globalOf(), '{"auth_mode":"chatgpt","account":"system"}');
    writeFileSync(sessionOf(), '{"auth_mode":"chatgpt","account":"stale"}');

    rehealResumeCodexAuth(codexHome, { home });

    expect(lstatSync(sessionOf()).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessionOf())).toBe(realpathSync(globalOf()));
    expect(readFileSync(sessionOf(), "utf8")).toContain('"account":"system"');
  });

  it("leaves a healthy system-auth symlink byte-identical", () => {
    writeFileSync(globalOf(), '{"auth_mode":"chatgpt"}');
    symlinkSync(globalOf(), sessionOf());
    const before = lstatSync(sessionOf());

    rehealResumeCodexAuth(codexHome, { home });

    expect(lstatSync(sessionOf()).ino).toBe(before.ino);
    expect(lstatSync(sessionOf()).mtimeMs).toBe(before.mtimeMs);
  });

  it("does not clobber an isolated credential when no system login exists", () => {
    rmSync(globalOf(), { force: true });
    writeFileSync(sessionOf(), '{"auth_mode":"chatgpt","account":"isolated"}');

    rehealResumeCodexAuth(codexHome, { home });

    expect(lstatSync(sessionOf()).isSymbolicLink()).toBe(false);
    expect(readFileSync(sessionOf(), "utf8")).toContain('"account":"isolated"');
  });

  it("never throws when the target home is absent", () => {
    writeFileSync(globalOf(), '{"auth_mode":"chatgpt"}');
    rmSync(codexHome, { recursive: true, force: true });
    expect(() => rehealResumeCodexAuth(codexHome, { home })).not.toThrow();
  });
});

describe("usePtyHost — managed-pty rollout gate (turn-lifecycle-control Phase 3)", () => {
  const tty = { isTTY: true };
  const notTty = { isTTY: false };

  it("is ON by default for an interactive TTY (managed-pty IS the launch path, D-006)", () => {
    // Flipped 2026-06-08 after the feel-check (P-012/P-015). A bare interactive
    // launch now goes through the managed pty.
    expect(PTY_DEFAULT_ON).toBe(true);
    expect(usePtyHost({ env: {}, stdin: tty, stdout: tty })).toBe(true);
  });

  it("still needs a real TTY on BOTH ends — a non-TTY launch keeps the plain spawn", () => {
    // brain dock pane / --no-picker scripts have no terminal to bridge.
    expect(usePtyHost({ env: {}, stdin: notTty, stdout: tty })).toBe(false);
    expect(usePtyHost({ env: {}, stdin: tty, stdout: notTty })).toBe(false);
  });

  it("PAPERCUSP_PSU_NO_PTY=1 is an always-wins kill switch", () => {
    expect(
      usePtyHost({
        env: { PAPERCUSP_PSU_NO_PTY: "1" },
        stdin: tty,
        stdout: tty,
      }),
    ).toBe(false);
  });

  it("PAPERCUSP_PSU_PTY=0 opts a single launch out of the default", () => {
    expect(
      usePtyHost({ env: { PAPERCUSP_PSU_PTY: "0" }, stdin: tty, stdout: tty }),
    ).toBe(false);
  });

  it("PAPERCUSP_PSU_PTY=1 is still honored as an explicit enable", () => {
    expect(
      usePtyHost({ env: { PAPERCUSP_PSU_PTY: "1" }, stdin: tty, stdout: tty }),
    ).toBe(true);
  });

  describe("PAPERCUSP_PSU_HEADLESS — a headless fleet member keeps the injectable pty despite no TTY (headless-fleet-launch P-001)", () => {
    it("bypasses the isTTY check so a non-TTY launch STILL takes the managed pty", () => {
      // The whole point: without the pty there is no control socket / discovery file,
      // so wake-executor Channel 3 parks the member forever after one turn.
      expect(
        usePtyHost({
          env: { PAPERCUSP_PSU_HEADLESS: "1" },
          stdin: notTty,
          stdout: notTty,
        }),
      ).toBe(true);
      expect(
        usePtyHost({
          env: { PAPERCUSP_PSU_HEADLESS: "1" },
          stdin: notTty,
          stdout: tty,
        }),
      ).toBe(true);
    });

    it("does NOT override the PAPERCUSP_PSU_NO_PTY kill switch", () => {
      expect(
        usePtyHost({
          env: { PAPERCUSP_PSU_HEADLESS: "1", PAPERCUSP_PSU_NO_PTY: "1" },
          stdin: notTty,
          stdout: notTty,
        }),
      ).toBe(false);
    });

    it("does NOT override an explicit PAPERCUSP_PSU_PTY=0 opt-out", () => {
      expect(
        usePtyHost({
          env: { PAPERCUSP_PSU_HEADLESS: "1", PAPERCUSP_PSU_PTY: "0" },
          stdin: notTty,
          stdout: notTty,
        }),
      ).toBe(false);
    });

    it("is inert when unset — a plain non-TTY launch still keeps the plain spawn", () => {
      expect(usePtyHost({ env: {}, stdin: notTty, stdout: notTty })).toBe(
        false,
      );
    });
  });
});

describe("spawnInherit — plain fallback owns and cleans up the backend process group (EI-20234301056067173)", () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it.each([null, "SIGINT"])("prints the psu resume hint after an interactive exit (%s) and before returning control", async (signal) => {
    const child = Object.assign(new EventEmitter(), { pid: 4142, kill: vi.fn() });
    const write = vi.fn();
    const processExit = vi.fn();
    const processKill = vi.fn();
    const owner = "su-12345678-1234-4abc-8abc-123456789abc";
    spawnInherit({
      wrapperBin: "codex", cwd: "/tmp", env: { PAPERCUSP_SID: owner },
      spawnImpl: () => child, signalSource: new EventEmitter(),
      processApi: { pid: 9000, stdin: { isTTY: true }, stdout: { isTTY: true, write }, exit: processExit, kill: processKill },
      reportSessionEndedImpl: async () => undefined,
    });
    child.emit("exit", 0, signal);
    await flush();
    expect(write).toHaveBeenCalledExactlyOnceWith(`\npsu: Resume this agent with: psu --resume ${owner}\n`);
    const end = signal ? processKill : processExit;
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(end.mock.invocationCallOrder.at(-1)!);
    child.emit("exit", 0, signal);
    expect(write).toHaveBeenCalledOnce();
  });

  it("suppresses resume hints in headless or nonterminal runs", () => {
    const write = vi.fn();
    const tty = { stdin: { isTTY: true }, stdout: { isTTY: true, write } };
    expect(printPsuResumeHint({ PAPERCUSP_SID: "su-test", PAPERCUSP_PSU_HEADLESS: "1" }, tty as never)).toBe(false);
    expect(printPsuResumeHint({ PAPERCUSP_SID: "su-test" }, { ...tty, stdout: { isTTY: false, write } } as never)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("uses a tracked session ID for other roles and never prints unsafe shell input", () => {
    const write = vi.fn();
    const tty = { stdin: { isTTY: true }, stdout: { isTTY: true, write } };
    expect(printPsuResumeHint({ PAPERCUSP_SID: "role-worker", PAPERCUSP_ADV_SESSION_ID: "31413" }, tty as never)).toBe(true);
    expect(write).toHaveBeenLastCalledWith("\npsu: Resume this agent with: psu --resume 31413\n");
    printPsuResumeHint({ PAPERCUSP_SID: "su-owner; echo unsafe", PAPERCUSP_ADV_SESSION_ID: "$(unsafe)" }, tty as never);
    expect(write).toHaveBeenLastCalledWith("\npsu: Resume this agent with: psu --resume\n");
  });

  it("finalizes only after Node confirms the direct child spawned", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4141;
    child.kill = vi.fn();
    const onSpawn = vi.fn(async () => undefined);
    const report = vi.fn(async () => undefined);

    spawnInherit({
      wrapperBin: "codex-su",
      cwd: "/tmp",
      env: { PAPERCUSP_ADV_SESSION_ID: "17" },
      spawnImpl: vi.fn(() => child),
      processApi: { pid: 9000, kill: vi.fn(), exit: vi.fn() },
      signalSource: new EventEmitter(),
      reportSessionEndedImpl: report,
      onSpawn,
    });

    expect(onSpawn).not.toHaveBeenCalled();
    child.emit("spawn");
    await flush();
    expect(onSpawn).toHaveBeenCalledOnce();
    child.emit("exit", 0, null);
    await flush();
  });

  it("detaches the wrapper and kills its group plus direct child after exit", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4242;
    child.kill = vi.fn();
    const spawnImpl = vi.fn(() => child);
    const processKill = vi.fn();
    const processExit = vi.fn();
    const signalSource = new EventEmitter();
    const report = vi.fn(async () => undefined);

    spawnInherit({
      wrapperBin: "codex-su",
      args: ["--resume", "native-id"],
      cwd: "/tmp",
      env: {},
      spawnImpl,
      processApi: { pid: 9001, kill: processKill, exit: processExit },
      signalSource,
      reportSessionEndedImpl: report,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      "codex-su",
      ["--resume", "native-id"],
      { cwd: "/tmp", env: {}, stdio: "inherit", detached: true },
    );
    child.emit("exit", 7, null);
    await flush();

    expect(processKill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(report).toHaveBeenCalledWith(null, 7, { killedBySignal: null });
    expect(processExit).toHaveBeenCalledWith(7);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    expect(signalSource.listenerCount("SIGHUP")).toBe(0);
  });

  it("reports a wrapper spawn error as launch-failed cleanup before exiting", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4444;
    child.kill = vi.fn();
    const processKill = vi.fn();
    const processExit = vi.fn();
    const signalSource = new EventEmitter();
    const report = vi.fn(async () => undefined);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    spawnInherit({
      wrapperBin: "codex-su",
      cwd: "/tmp",
      env: { PAPERCUSP_ADV_SESSION_ID: "17" },
      spawnImpl: vi.fn(() => child),
      processApi: { pid: 9003, kill: processKill, exit: processExit },
      signalSource,
      reportSessionEndedImpl: report,
    });

    child.emit("error", new Error("ENOENT"));
    await flush();

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith("17", null, { launchFailed: true });
    expect(processKill).toHaveBeenCalledWith(-4444, "SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(processExit).toHaveBeenCalledWith(127);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    expect(signalSource.listenerCount("SIGHUP")).toBe(0);
    errorSpy.mockRestore();
  });

  it("releases a tracked reservation on a pre-spawn error", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4545;
    child.kill = vi.fn();
    const release = vi.fn(async () => undefined);
    const report = vi.fn(async () => undefined);
    const processExit = vi.fn();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    spawnInherit({
      wrapperBin: "codex-su",
      cwd: "/tmp",
      env: { PAPERCUSP_ADV_SESSION_ID: "17" },
      spawnImpl: vi.fn(() => child),
      processApi: { pid: 9004, kill: vi.fn(), exit: processExit },
      signalSource: new EventEmitter(),
      reportSessionEndedImpl: report,
      onSpawnFailure: release,
    });

    child.emit("error", new Error("ENOENT"));
    await flush();

    expect(release).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    expect(processExit).toHaveBeenCalledWith(127);
    errorSpy.mockRestore();
  });

  it("forwards a parent termination signal and removes handlers before re-signalling the parent", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4343;
    child.kill = vi.fn();
    const processKill = vi.fn();
    const processExit = vi.fn();
    const signalSource = new EventEmitter();
    const report = vi.fn(async () => undefined);

    spawnInherit({
      wrapperBin: "codex-su",
      cwd: "/tmp",
      env: { PAPERCUSP_ADV_SESSION_ID: "17" },
      spawnImpl: vi.fn(() => child),
      processApi: { pid: 9002, kill: processKill, exit: processExit },
      signalSource,
      reportSessionEndedImpl: report,
    });

    signalSource.emit("SIGTERM");
    expect(processKill).toHaveBeenCalledWith(-4343, "SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", null, "SIGTERM");
    await flush();

    expect(report).toHaveBeenCalledWith("17", null, {
      killedBySignal: "SIGTERM",
    });
    expect(processKill).toHaveBeenCalledWith(9002, "SIGTERM");
    expect(processExit).not.toHaveBeenCalled();
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    expect(signalSource.listenerCount("SIGHUP")).toBe(0);
  });
});

describe("sessionIsResumable — picker keeps on-disk OR DB-archived sessions (WI-4714, off-disk migration)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-resumable-"));
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("KEEPS an off-disk session that is DB-archived (hasArchive) even with NO on-disk transcript", () => {
    // The ended session's transcript was moved off disk to the DB archive — so the
    // on-disk-only sessionHasTranscript would hide it as a ghost, but the server
    // stamped hasArchive:true and it IS resumable (rematerialized on selection).
    mkdirSync(
      join(home, ".papercusp", "session-claude", "su-arch", "projects"),
      { recursive: true },
    );
    const s = {
      agent: "claude",
      sessionId: UUID,
      coordOwnerId: "su-arch",
      hasArchive: true,
    };
    expect(sessionHasTranscript(s, { home })).toBe(false); // on-disk check alone would HIDE it
    expect(sessionIsResumable(s, { home })).toBe(true); // …but it must be KEPT
  });

  it("HIDES a true ghost — no on-disk transcript AND not archived", () => {
    mkdirSync(
      join(home, ".papercusp", "session-claude", "su-ghost2", "projects"),
      { recursive: true },
    );
    const s = { agent: "claude", sessionId: UUID, coordOwnerId: "su-ghost2" };
    expect(sessionIsResumable(s, { home })).toBe(false);
  });

  it("KEEPS an on-disk session regardless of the hasArchive flag", () => {
    const owner = "su-live";
    const projDir = join(
      home,
      ".papercusp",
      "session-claude",
      owner,
      "projects",
      "-d",
    );
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    expect(
      sessionIsResumable(
        { agent: "claude", sessionId: UUID, coordOwnerId: owner },
        { home },
      ),
    ).toBe(true);
  });
});

describe("original Codex routing — existing profile only", () => {
  const uuid = "0123abcd-1234-5678-9abc-def012345678";
  let home: string;
  let source: any;
  let pin: any;
  const deps = { liveHost: () => null, writerHolder: () => ({ held: false, reason: "free" }) };
  const config = () => readFileSync(join(home, "config.toml"), "utf8");
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-original-route-"));
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(home, "sessions", `rollout-${uuid}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: uuid, model_provider: "openai" } }) + "\n");
    writeFileSync(join(home, "AGENTS.md"), "Original session instructions\n");
    writeFileSync(join(home, "config.toml"), 'model = "gpt-6"\nmodel_reasoning_effort = "high"\n[mcp_servers.papercusp-su]\nurl = "http://localhost/api/mcp?client=su-original"\n[tui]\nterminal_title = []\nalternate_screen = "never"\n');
    writeFileSync(join(home, "papercusp-diagnostics.json"), JSON.stringify({ lockOwnerSid: "su-original" }));
    const hook = { hooks: [{ command: "PAPERCUSP_SID='su-original' lifecycle-report.sh" }] };
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [hook], SessionEnd: [hook], Stop: [hook] } }));
    source = { id: 42, agent: "codex", coordOwnerId: "su-original", sessionId: uuid,
      endedAt: "2026-10-07T00:00:00Z", startedAt: "2026-10-06T00:00:00Z", codexHome: home,
      cwd: "/original", role: "su", feature: "WI-original", workspaceId: "workspace-original",
      planSlug: "original-plan", launchArgv: ["psu", "--account=auto", "--carry=cold"] };
    pin = { ownerId: source.coordOwnerId, advSessionId: source.id, sessionId: uuid,
      codexHome: home, profileFingerprint: codexOriginalRoutingFingerprint(home, uuid) };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("accepts the real exact-resume command's unset parsed subagent option", () => {
    const launchArgs = parseArgs(["--launched-by=su-caller", "--no-picker", "--account=auto", `--resume=${uuid}`]);
    expect(launchArgs.allowSubagents).toBeNull();
    expect(() => assertOriginalCodexRouting(source, pin, { ...deps, launchArgs })).not.toThrow();
  });

  it.each(["--allow-subagents", "--no-subagents", "--agent=codex", "--model=gpt-6", "--mode=grade"])(
    "refuses an explicit parsed routing override (%s)", (override) => {
      const launchArgs = parseArgs(["--no-picker", "--account=auto", `--resume=${uuid}`, override]);
      expect(() => assertOriginalCodexRouting(source, pin, { ...deps, launchArgs })).toThrow("settings overrides");
    });

  it.each(["auto", "codex-pinned-account"])("patches only the provider for the original saved %s route", async (saved) => {
    source.launchArgv[1] = `--account=${saved}`;
    const before = { agents: readFileSync(join(home, "AGENTS.md")), hooks: readFileSync(join(home, "hooks.json")),
      transcript: readFileSync(join(home, "sessions", `rollout-${uuid}.jsonl`)), session: JSON.stringify(source) };
    const apiImpl = vi.fn(async () => ({ sessions: [{ ...source }] }));
    await applyOriginalCodexRouting(source, pin, { mode: saved === "auto" ? "auto" : "pin", id: saved === "auto" ? null : saved }, { ...deps, apiImpl });
    expect(apiImpl).toHaveBeenCalledWith("/api/adv/sessions/resumable?id=42");
    expect(config()).toContain('model_provider = "papercusp-codex-gateway"');
    expect(config()).toContain('model_reasoning_effort = "high"');
    expect(config()).toContain('model = "gpt-6"');
    expect(readFileSync(join(home, "AGENTS.md"))).toEqual(before.agents);
    expect(readFileSync(join(home, "hooks.json"))).toEqual(before.hooks);
    expect(readFileSync(join(home, "sessions", `rollout-${uuid}.jsonl`))).toEqual(before.transcript);
    expect(JSON.stringify(source)).toBe(before.session);
  });

  it("preserves a restricted judge MCP profile during original routing recovery", async () => {
    source.role = "judge";
    writeFileSync(join(home, "config.toml"), config().replace("[mcp_servers.papercusp-su]", "[mcp_servers.papercusp]")
      .replace("?client=su-original", "?client=su-original&role=judge&sig=original-signature&exp=0"));
    pin.profileFingerprint = codexOriginalRoutingFingerprint(home, uuid);
    const before = { agents: readFileSync(join(home, "AGENTS.md")), hooks: readFileSync(join(home, "hooks.json")),
      transcript: readFileSync(join(home, "sessions", `rollout-${uuid}.jsonl`)) };
    await applyOriginalCodexRouting(source, pin, { mode: "auto" }, { ...deps, apiImpl: async () => ({ sessions: [source] }) });
    expect(config()).toContain("[mcp_servers.papercusp]");
    expect(config()).not.toContain("papercusp-su");
    expect(config()).toContain("client=su-original&role=judge&sig=original-signature&exp=0");
    expect(readFileSync(join(home, "AGENTS.md"))).toEqual(before.agents);
    expect(readFileSync(join(home, "hooks.json"))).toEqual(before.hooks);
    expect(readFileSync(join(home, "sessions", `rollout-${uuid}.jsonl`))).toEqual(before.transcript);
  });

  it.each(["role=worker", "role=judge&superuser=1", "role=judge&client=su-other", "role=judge&sig="])(
    "refuses a restricted role profile with mismatched authority (%s)", (query) => {
      source.role = "judge";
      writeFileSync(join(home, "config.toml"), config().replace("[mcp_servers.papercusp-su]", "[mcp_servers.papercusp]")
        .replace("?client=su-original", `?client=su-original&sig=original-signature&${query}`));
      pin.profileFingerprint = codexOriginalRoutingFingerprint(home, uuid);
      const before = config();
      expect(() => assertOriginalCodexRouting(source, pin, deps)).toThrow("restricted role");
      expect(config()).toBe(before);
    });

  it("refuses an SU profile for a recorded restricted role", () => {
    source.role = "judge";
    expect(() => assertOriginalCodexRouting(source, pin, deps)).toThrow("restricted role");
  });

  it.each([{ coordOwnerId: "su-other" }, { id: 43 }, { sessionId: "another-thread" },
    { agent: "claude" }, { endedAt: null }, { launchArgv: ["--account=default"] }])(
    "refuses wrong custody/prerequisites before provider writes: %j", async (change) => {
      const before = config();
      await expect(applyOriginalCodexRouting(source, pin, { mode: "auto" },
        { ...deps, apiImpl: async () => ({ sessions: [{ ...source, ...change }] }) })).rejects.toThrow("refused");
      expect(config()).toBe(before);
    });

  it.each(["held", "no-proc-locks", "stat-error"])("refuses a live or unknown writer (%s) without changing config", (reason) => {
    const before = config();
    expect(() => assertOriginalCodexRouting(source, pin, { ...deps,
      writerHolder: () => ({ held: reason === "held", reason }) })).toThrow("writer");
    expect(config()).toBe(before);
  });

  it("refuses a live host even when the writer probe is free", () => {
    expect(() => assertOriginalCodexRouting(source, pin, { ...deps, liveHost: () => ({ pid: 42 }) })).toThrow("host");
  });

  it.each(["AGENTS.md", "config.toml", "hooks.json", "sessions"])("refuses missing %s instead of repairing/restoring it", (file) => {
    rmSync(join(home, file), { recursive: true });
    expect(() => assertOriginalCodexRouting(source, pin, deps)).toThrow("refused");
    expect(existsSync(join(home, file))).toBe(false);
  });

  it("refuses a profile race during the post-reservation exact-row read", async () => {
    const before = config();
    await expect(applyOriginalCodexRouting(source, pin, { mode: "auto" }, { ...deps, apiImpl: async () => {
      writeFileSync(join(home, "AGENTS.md"), "changed while reserved");
      return { sessions: [source] };
    } })).rejects.toThrow("profile");
    expect(config()).toBe(before);
  });

  it("refuses a saved account mismatch before provider writes", async () => {
    const before = config();
    await expect(applyOriginalCodexRouting(source, pin, { mode: "pin", id: "other-account" },
      { ...deps, apiImpl: async () => ({ sessions: [source] }) })).rejects.toThrow("account");
    expect(config()).toBe(before);
  });

  it("consumes the launch-only guard and strips it from inherited child env", () => {
    const env = { [ORIGINAL_CODEX_ROUTING_ENV]: JSON.stringify(pin) };
    expect(consumeOriginalCodexRouting(env)).toEqual(pin);
    expect(env).toEqual({});
    expect(sanitizeInheritedEnv({ [ORIGINAL_CODEX_ROUTING_ENV]: JSON.stringify(pin) })).not.toHaveProperty(ORIGINAL_CODEX_ROUTING_ENV);
  });
});

describe("ensureResumeTranscriptPresent — the archive-at-death race (owner-hit 2026-08-12, WI-38236)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  it("uses the saved OMP home for transcript preflight and native resume", async () => {
    const agentHome = join(home, 'relocated-omp', 'agent');
    const sessions = join(agentHome, 'sessions', 'project');
    mkdirSync(sessions, { recursive: true });
    const transcript = join(sessions, `2026-10-12T00-00-00_${UUID}.jsonl`);
    writeFileSync(transcript, `{"type":"session","id":"${UUID}"}\n`);
    const source = { id: 42, agent: 'omp', ompThreadId: UUID, agentHome };
    const rematerialize = vi.fn(async () => null);
    expect(sessionTranscriptFile(source, { home })).toBe(transcript);
    await expect(ensureResumeTranscriptPresent(source, { home, rematerialize })).resolves.toBe(true);
    expect(rematerialize).not.toHaveBeenCalled();
    expect(ompTrackedResumeEnv(source, { home })).toMatchObject({
      PI_CONFIG_DIR: 'relocated-omp', PI_CODING_AGENT_DIR: agentHome,
    });
  });

  it("uses the configured OMP root when no saved OMP home was supplied", async () => {
    const root = join(home, 'configured-omp');
    vi.stubEnv('PAPERCUSP_SU_OMP_HOMES_DIR', root);
    try {
      const agentHome = join(root, 'session-42', 'agent');
      const sessions = join(agentHome, 'sessions', 'project');
      mkdirSync(sessions, { recursive: true });
      const transcript = join(sessions, `2026-10-12T00-00-00_${UUID}.jsonl`);
      writeFileSync(transcript, `{"type":"session","id":"${UUID}"}\n`);
      const source = { id: 42, agent: 'omp', ompThreadId: UUID };
      const rematerialize = vi.fn(async () => null);
      expect(sessionTranscriptFile(source, { home })).toBe(transcript);
      await expect(ensureResumeTranscriptPresent(source, { home, rematerialize })).resolves.toBe(true);
      expect(rematerialize).not.toHaveBeenCalled();
      expect(ompTrackedResumeEnv(source, { home }).PI_CODING_AGENT_DIR).toBe(agentHome);
    } finally { vi.unstubAllEnvs(); }
  });

  it("does not replace a missing saved OMP home with a transcript in another home", async () => {
    const sessions = join(home, '.papercusp', 'su-omp-homes', 'session-42', 'agent', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `2026-10-12T00-00-00_${UUID}.jsonl`), '{}\n');
    const source = { id: 42, agent: 'omp', ompThreadId: UUID, agentHome: join(home, 'missing', 'agent') };
    const rematerialize = vi.fn(async () => null);
    await expect(ensureResumeTranscriptPresent(source, { home, rematerialize })).resolves.toBe(false);
    expect(rematerialize).toHaveBeenCalledWith(UUID, 'omp', { sourceSession: source, home });
    expect(ompTrackedResumeEnv(source, { home })).toEqual({});
  });

  it("uses the saved Codex home for exact resume without restoring an unrelated default home", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'pui-saved-codex-'));
    try {
      const sessions = join(codexHome, 'sessions', '2026', '09', '08');
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, `rollout-2026-09-08T00-00-00-${UUID}.jsonl`), '{}\n');
      const rematerialize = vi.fn(async () => null);
      const source = { id: 42, agent: 'codex', sessionId: UUID, codexHome };
      expect(sessionHasTranscript(source, { home })).toBe(true);
      await expect(ensureResumeTranscriptPresent(source, { home, rematerialize })).resolves.toBe(true);
      expect(rematerialize).not.toHaveBeenCalled();
      expect(sessionHasTranscript({ ...source, sessionId: 'different-thread' }, { home })).toBe(false);
    } finally { rmSync(codexHome, { recursive: true, force: true }); }
  });

  it.each([
    { name: 'HTTP admission refusal', response: () => new Response(JSON.stringify({ ok: false, error: 'mcp_proxy_overloaded' }), { status: 429 }), cause: 'HTTP 429' },
    { name: 'malformed archive response', response: () => new Response('not JSON', { status: 200 }), cause: 'invalid_response' },
    { name: 'unreachable archive service', response: () => { throw new Error('ECONNREFUSED'); }, cause: 'ECONNREFUSED' },
  ])("preserves $name instead of declaring the indexed native archive absent", async ({ response, cause }) => {
    const source = { id: 42329, agent: 'codex', sessionId: UUID, coordOwnerId: 'su-original-reviewer' };
    const before = structuredClone(source);
    const rematerialize = (id, agent, options) => tryRematerializeFromArchive(id, agent, {
      ...options, operatorUrl: 'http://archive', token: 'fixture-token', fetchImpl: async () => response(),
    });
    expect(sessionHasTranscript(source, { home })).toBe(false);
    await expect(ensureResumeTranscriptPresent(source, { home, rematerialize }))
      .rejects.toThrow(cause);
    expect(source).toEqual(before);
  });

  it("reports archive absence only after the service explicitly confirms not_archived", async () => {
    const source = { id: 42329, agent: 'codex', sessionId: UUID };
    const rematerialize = (id, agent, options) => tryRematerializeFromArchive(id, agent, {
      ...options, operatorUrl: 'http://archive', token: 'fixture-token',
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, reason: 'not_archived' }), { status: 404 }),
    });
    await expect(ensureResumeTranscriptPresent(source, { home, rematerialize })).resolves.toBe(false);
  });

  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-resume-race-"));
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const projDirFor = (owner: string) =>
    join(home, ".papercusp", "session-claude", owner, "projects", "-d");

  it("RESTORES a transcript deleted between the resolve and the exec — the exact owner repro", async () => {
    // Repro of adv 15148: the session ended, psu resolved it while the transcript
    // was still on disk, then the 15s archive-at-death timer deleted it WHILE the
    // user answered the backend/model + account prompts. Before this guard, psu
    // exec'd claude anyway and the owner got "No conversation found with session ID".
    const owner = "su-raced";
    mkdirSync(projDirFor(owner), { recursive: true });
    // ...the file is ALREADY gone by the time we re-check (the timer fired mid-prompt).
    const source = { agent: "claude", sessionId: UUID, coordOwnerId: owner };
    expect(sessionHasTranscript(source, { home })).toBe(false);

    // The bytes are safe in the DB archive; the restore puts them back on disk.
    const rematerialize = vi.fn(async () => {
      writeFileSync(
        join(projDirFor(owner), `${UUID}.jsonl`),
        `{"sessionId":"${UUID}"}\n`,
      );
      return { ok: true, written: 1 };
    });
    await expect(
      ensureResumeTranscriptPresent(source, { home, rematerialize }),
    ).resolves.toBe(true);
    expect(rematerialize).toHaveBeenCalledWith(UUID, "claude", { sourceSession: source, home });
  });

  it("REFUSES the launch when the transcript is gone AND the archive cannot restore it", async () => {
    // The failure psu used to hand to claude as "No conversation found" — reported
    // by psu itself now, with the real reason, instead of exec'ing a doomed id.
    const owner = "su-nothing";
    mkdirSync(projDirFor(owner), { recursive: true });
    const rematerialize = vi.fn(async () => null);
    await expect(
      ensureResumeTranscriptPresent(
        { agent: "claude", sessionId: UUID, coordOwnerId: owner },
        { home, rematerialize },
      ),
    ).resolves.toBe(false);
  });

  it("pins a native resume to the relocated archive root before checking restored bytes", async () => {
    const source = { agent: "claude", sessionId: UUID, coordOwnerId: "su-relocated", configDir: join(home, "old") };
    const restoredRoot = join(home, "restored");
    const project = join(restoredRoot, "projects", "-d");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    const rematerialize = (id, agent, options) => tryRematerializeFromArchive(id, agent, {
      ...options, home, operatorUrl: "http://operator", token: "test-token",
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true, written: 1, root: restoredRoot, sourceKind: "claude",
      }), { status: 200 }),
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(ensureResumeTranscriptPresent(source, { home, rematerialize })).resolves.toBe(true);
      expect(source.configDir).toBe(restoredRoot);
      expect(source.coordOwnerId).toBe("su-relocated");
      expect(source.sessionId).toBe(UUID);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("transcript restored from the session archive"));
    } finally { stderr.mockRestore(); }
  });

  it("does NOT restore when the transcript is still on disk — the healthy resume pays no round-trip", async () => {
    const owner = "su-ondisk";
    mkdirSync(projDirFor(owner), { recursive: true });
    writeFileSync(
      join(projDirFor(owner), `${UUID}.jsonl`),
      `{"sessionId":"${UUID}"}\n`,
    );
    const rematerialize = vi.fn(async () => null);
    await expect(
      ensureResumeTranscriptPresent(
        { agent: "claude", sessionId: UUID, coordOwnerId: owner },
        { home, rematerialize },
      ),
    ).resolves.toBe(true);
    expect(rematerialize).not.toHaveBeenCalled();
  });

  it("passes omp through untouched — it resumes by thread name, not an id-addressed transcript", async () => {
    const rematerialize = vi.fn(async () => null);
    await expect(
      ensureResumeTranscriptPresent(
        { agent: "omp", ompThreadId: "some-thread" },
        { home, rematerialize },
      ),
    ).resolves.toBe(true);
    expect(rematerialize).not.toHaveBeenCalled();
  });

  it("refuses a tracked OMP ghost and restores its native thread before a native resume", async () => {
    const source = { agent: "omp", id: 42, ompThreadId: "t-1", sessionId: "different-row-native" };
    const missing = vi.fn(async () => null);
    await expect(ensureResumeTranscriptPresent(source, { home, rematerialize: missing })).resolves.toBe(false);
    expect(missing).toHaveBeenCalledWith("t-1", "omp", { sourceSession: source, home });
    const restore = vi.fn(async () => {
      const dir = join(home, ".papercusp", "su-omp-homes", "session-42", "agent", "sessions", "project");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-07-16T00-00-00_t-1.jsonl"), '{"type":"session","id":"t-1"}\n');
      return { ok: true };
    });
    await expect(ensureResumeTranscriptPresent(source, { home, rematerialize: restore })).resolves.toBe(true);
    expect(restore).toHaveBeenCalledWith("t-1", "omp", { sourceSession: source, home });
    await expect(ensureResumeTranscriptPresent(source, { home, rematerialize: missing })).resolves.toBe(true);
    expect(missing).toHaveBeenCalledOnce();
  });
});

describe("launchResolvedResume WIRING — the transcript re-verify must run AFTER the prompts (WI-38236)", () => {
  // ensureResumeTranscriptPresent is only worth anything if it is called at the
  // right MOMENT. The whole bug is that the earlier check happens before two
  // human-paced prompts; a re-verify placed above them would be just as useless,
  // and a removed call would silently restore the original failure. Both are
  // invisible to behavioural tests of the helper itself, so pin the call site.
  const src = readFileSync(
    join(__dirname, "..", "scripts", "psu-launcher.mjs"),
    "utf8",
  );
  const body = src.slice(src.indexOf("async function launchResolvedResume("));

  it("calls ensureResumeTranscriptPresent before handing off to launchResume/launchTrackedFork", () => {
    const guard = body.indexOf("await ensureResumeTranscriptPresent(source)");
    const fork = body.indexOf("await launchTrackedFork(");
    const resume = body.indexOf("await launchResume(source, {");
    expect(guard).toBeGreaterThan(-1);
    expect(fork).toBeGreaterThan(guard);
    expect(resume).toBeGreaterThan(guard);
  });

  it("runs it AFTER both prompts — a check above them re-opens the race it exists to close", () => {
    const target = body.indexOf("await chooseResumeTarget(");
    const account = body.indexOf("await chooseResumeAccount(");
    const guard = body.indexOf("await ensureResumeTranscriptPresent(source)");
    expect(guard).toBeGreaterThan(target);
    expect(guard).toBeGreaterThan(account);
  });
});

describe("sessionHasTranscript (ghost rows — adv-tracked launches that never persisted a turn)", () => {
  const UUID = "0123abcd-1234-5678-9abc-def012345678";
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-ghosts-"));
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const writeClaudeTranscript = (configDir) => {
    const projDir = join(configDir, "projects", "-some-dir");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
  };

  it("claude: TRUE when the transcript lives in the EI-155 isolated config dir (derived from coordOwnerId)", () => {
    const owner = "su-owner-9";
    writeClaudeTranscript(join(home, ".papercusp", "session-claude", owner));
    expect(
      sessionHasTranscript(
        { agent: "claude", sessionId: UUID, coordOwnerId: owner },
        { home },
      ),
    ).toBe(true);
  });

  it("claude: TRUE when the transcript lives in the shared ~/.claude store (pre-EI-155 sessions)", () => {
    writeClaudeTranscript(join(home, ".claude"));
    expect(
      sessionHasTranscript(
        { agent: "claude", sessionId: UUID, coordOwnerId: "su-other" },
        { home },
      ),
    ).toBe(true);
  });

  it('claude: FALSE for a ghost — known sessionId, no transcript anywhere (the "No conversation found" row)', () => {
    // The launch materialized the config dir but died before its first turn.
    mkdirSync(
      join(home, ".papercusp", "session-claude", "su-ghost", "projects"),
      { recursive: true },
    );
    expect(
      sessionHasTranscript(
        { agent: "claude", sessionId: UUID, coordOwnerId: "su-ghost" },
        { home },
      ),
    ).toBe(false);
  });

  it("claude: KEEPS a pre-native-id row (no sessionId — resume falls back to --continue, unverifiable)", () => {
    expect(
      sessionHasTranscript(
        { agent: "claude", sessionId: null, coordOwnerId: "su-legacy" },
        { home },
      ),
    ).toBe(true);
  });

  it("claude: an explicit session.configDir (untracked isolated hit) wins over the owner derivation", () => {
    const configDir = join(home, "elsewhere", "iso-dir");
    writeClaudeTranscript(configDir);
    expect(
      sessionHasTranscript(
        { agent: "claude", sessionId: UUID, configDir },
        { home },
      ),
    ).toBe(true);
  });

  it("codex: TRUE when the per-session CODEX_HOME holds the rollout; FALSE when it does not", () => {
    const dir = join(
      home,
      ".papercusp",
      "su-codex-homes",
      "session-42",
      "sessions",
      "2026",
      "06",
      "12",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-06-12T09-00-00-${UUID}.jsonl`),
      `{"type":"meta"}\n`,
    );
    expect(
      sessionHasTranscript(
        { agent: "codex", id: 42, sessionId: UUID },
        { home },
      ),
    ).toBe(true);
    expect(
      sessionHasTranscript(
        { agent: "codex", id: 43, sessionId: UUID },
        { home },
      ),
    ).toBe(false);
  });

  /*
   * WI-38226 — this assertion FLIPPED, deliberately. It used to read
   * `{ agent:'codex', id:42, sessionId:null } → true` under "no sessionId ⇒ unverifiable ⇒
   * keep". That premise was wrong: a codex resume runs `codex resume --last` pinned to THIS
   * row's own isolated CODEX_HOME (resumeArgsFor + launchResume's CODEX_HOME pin), so "is
   * there anything to resume" is answerable without an id — just look in that home. Treating
   * it as unverifiable made the picker offer launches that die on selection, and it was not a
   * rare corner: measured on the live box, 127 of the 241 most recent codex rows had no
   * session_id AND no rollout on disk (128 had no CODEX_HOME at all).
   *
   * The genuinely unverifiable case — no adv row id, hence no home to look in — still keeps.
   */
  it("codex: no sessionId → verifies the home holds ANY rollout (what `resume --last` will find)", () => {
    const dir = join(
      home,
      ".papercusp",
      "su-codex-homes",
      "session-42",
      "sessions",
      "2026",
      "06",
      "12",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-06-12T09-00-00-${UUID}.jsonl`),
      `{"type":"meta"}\n`,
    );
    expect(
      sessionHasTranscript(
        { agent: "codex", id: 42, sessionId: null },
        { home },
      ),
    ).toBe(true);
  });

  it("codex: FALSE for the no-sessionId GHOST — home exists but holds no rollout at all", () => {
    // The launch minted its CODEX_HOME and died before persisting a turn: `codex resume --last`
    // finds nothing, so offering this row hands the owner a session that cannot come back.
    mkdirSync(
      join(home, ".papercusp", "su-codex-homes", "session-42", "sessions"),
      { recursive: true },
    );
    expect(
      sessionHasTranscript(
        { agent: "codex", id: 42, sessionId: null },
        { home },
      ),
    ).toBe(false);
    // …and the same when the home was never created at all (the more common shape on disk).
    expect(
      sessionHasTranscript(
        { agent: "codex", id: 99, sessionId: null },
        { home },
      ),
    ).toBe(false);
  });

  it("codex: KEEPS a row with no adv id — there is no tracked home to check, so it IS unverifiable", () => {
    expect(
      sessionHasTranscript(
        { agent: "codex", id: null, sessionId: UUID },
        { home },
      ),
    ).toBe(true);
    expect(
      sessionHasTranscript(
        { agent: "codex", id: null, sessionId: null },
        { home },
      ),
    ).toBe(true);
  });

  it("omp: verifies the tracked per-session transcript by native thread id", () => {
    const dir = join(
      home,
      ".papercusp",
      "su-omp-homes",
      "session-42",
      "agent",
      "sessions",
      "some-project",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-07-16T00-00-00_t-1.jsonl"),
      '{"type":"session","id":"t-1"}\n',
    );
    expect(
      sessionHasTranscript(
        { agent: "omp", id: 42, ompThreadId: "t-1" },
        { home },
      ),
    ).toBe(true);
    expect(
      sessionHasTranscript(
        { agent: "omp", id: 42, ompThreadId: "missing" },
        { home },
      ),
    ).toBe(false);
  });
});

describe("WI-3758 — psu --resume model select + last-active model", () => {
  it("modelArgsFor maps a spec onto each backend (and stays in lockstep with suWrapperExtraArgs)", () => {
    // claude: a recognized :effort tail splits into the CLI's own --effort flag.
    expect(modelArgsFor("claude", "claude-sonnet-5:high")).toEqual([
      "--model",
      "claude-sonnet-5",
      "--effort",
      "high",
    ]);
    // …but a non-effort ':' segment (bedrock version) passes through verbatim.
    expect(modelArgsFor("claude", "anthropic.claude-3-5-sonnet-v2:0")).toEqual([
      "--model",
      "anthropic.claude-3-5-sonnet-v2:0",
    ]);
    expect(modelArgsFor("claude", "opus:xhigh")).toEqual([
      "--model",
      "opus",
      "--effort",
      "max",
    ]);
    expect(modelArgsFor("claude", "claude-opus-5-5:xhigh")).toEqual([
      "--model",
      "claude-opus-5-5",
      "--effort",
      "max",
    ]);
    expect(modelArgsFor("claude", "claude-opus-4-8:xhigh")).toEqual([
      "--model",
      "claude-opus-4-8",
      "--effort",
      "xhigh",
    ]);
    // OMP keeps its provider-native suffixed form unchanged.
    expect(modelArgsFor("omp", "opus:xhigh")).toEqual(["--model", "opus:xhigh"]);
    // codex: bare -m + config-override effort, preserving max verbatim.
    expect(modelArgsFor("codex", "gpt-5.5:max")).toEqual([
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="max"',
    ]);
    expect(modelArgsFor("codex", "gpt-5.5")).toEqual(["-m", "gpt-5.5"]);
    expect(modelArgsFor("codex", "sol:high")).toEqual([
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      ...codexContextConfigArgs("gpt-5.6-sol"),
    ]);
    expect(
      modelArgsFor("codex", "sol:high", { compactionLimit: 250_000 }),
    ).toEqual([
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      ...codexContextConfigArgs("gpt-5.6-sol", {
        compactionLimit: 250_000,
      }),
    ]);
    // omp understands the suffixed spec natively.
    expect(modelArgsFor("omp", "opus:high")).toEqual(["--model", "opus:high"]);
    expect(modelArgsFor("claude", null)).toEqual([]);
    // The wrapper path delegates — a divergence here would resurrect the effort-drop class.
    for (const [agent, spec] of [
      ["claude", "fable:high"],
      ["codex", "gpt-5.5:max"],
      ["omp", "opus:low"],
    ] as const) {
      // omp additionally carries the adv-21150 title mitigation
      // (ompTitleMitigationArgs), which is NOT a model arg — suWrapperExtraArgs
      // is a superset of modelArgsFor for that backend by design. Strip it
      // before the delegation comparison so this guard keeps testing the
      // effort-drop class it was written for (EI-7138) rather than silently
      // becoming an assertion about the mitigation's presence.
      expect(
        suWrapperExtraArgs(agent, { model: spec }).filter(
          (a) => a !== "--no-title",
        ),
      ).toEqual(modelArgsFor(agent, spec));
    }
  });

  it("WI-37890: refuses the broken Vertex Gemini 3.1 Pro high-effort spec without lowering it", () => {
    const exactHigh = "google-vertex/gemini-3.1-pro-preview:high";
    expect(() => normalizeOmpModelSpec(exactHigh)).toThrow(
      /Refusing to silently lower the requested effort/,
    );
    expect(() => modelArgsFor("omp", exactHigh)).toThrow(
      /choose :low explicitly/,
    );
    expect(() => ompModelCompatibilityNotice(exactHigh)).toThrow(
      /empty STOP responses/,
    );

    // Other providers, efforts, and models are not implicated by the controlled repro.
    expect(
      normalizeOmpModelSpec("google-vertex/gemini-3.1-pro-preview:low"),
    ).toBe("google-vertex/gemini-3.1-pro-preview:low");
    expect(
      normalizeOmpModelSpec("google-generative-ai/gemini-3.1-pro-preview:high"),
    ).toBe("google-generative-ai/gemini-3.1-pro-preview:high");
    expect(normalizeOmpModelSpec("google-vertex/gemini-3.0-pro:high")).toBe(
      "google-vertex/gemini-3.0-pro:high",
    );
    expect(ompModelCompatibilityNotice("opus:high")).toBeNull();
  });

  it("EI-21995330124084016: reconciles only gateway-routed Opus 5 resume xhigh to supported max", () => {
    const autoRoute = { mode: "auto", provider: "claude" };
    const pinnedRoute = { mode: "pin", provider: "claude" };

    expect(
      reconcileResumeModelForAccountRoute({
        agent: "claude",
        model: "claude-opus-5[1m]:xhigh",
        accountRoute: autoRoute,
      }),
    ).toMatchObject({
      model: "claude-opus-5[1m]:max",
      reconciled: true,
      notice: expect.stringMatching(/retired xhigh.*supported strongest level/s),
    });
    expect(
      reconcileResumeModelForAccountRoute({
        agent: "claude",
        model: "opus[1m]:xhigh",
        accountRoute: pinnedRoute,
      }),
    ).toMatchObject({ model: "opus[1m]:max", reconciled: true });

    // Route, family, backend, and effort controls stay byte-identical.
    for (const input of [
      {
        agent: "claude",
        model: "claude-opus-5[1m]:xhigh",
        accountRoute: { mode: "default", provider: null },
      },
      {
        agent: "claude",
        model: "claude-sonnet-5[1m]:xhigh",
        accountRoute: autoRoute,
      },
      {
        agent: "claude",
        model: "claude-opus-5[1m]:high",
        accountRoute: autoRoute,
      },
      {
        agent: "omp",
        model: "claude-opus-5:xhigh",
        accountRoute: autoRoute,
      },
      {
        agent: "codex",
        model: "gpt-5.6-sol:xhigh",
        accountRoute: { mode: "auto", provider: "codex" },
      },
    ]) {
      expect(reconcileResumeModelForAccountRoute(input)).toEqual({
        model: input.model,
        notice: null,
        reconciled: false,
      });
    }
  });

  // WI-10005900: an argv with no effort of its own falls back to settings.json
  // effortLevel, which Claude Code writes itself. On the `default` route there is
  // no gateway clamp, so the launch boundary must pass the clamped level.
  it("WI-10005900: claude argv clamps an inherited Opus 5 xhigh effortLevel on every launch path", () => {
    const xhighSettings = { model: "opus[1m]", effortLevel: "xhigh" };

    expect(
      modelArgsFor("claude", "opus[1m]", { claudeSettings: xhighSettings }),
    ).toEqual(["--model", "opus[1m]", "--effort", "max"]);
    expect(
      modelArgsFor("claude", null, { claudeSettings: xhighSettings }),
    ).toEqual(["--effort", "max"]);
    expect(
      suWrapperExtraArgs("claude", { claudeSettings: xhighSettings }),
    ).toEqual(["--effort", "max"]);

    const resumed = resumeArgsFor(
      { agent: "claude", sessionId: "uuid-1" },
      { claudeSettings: xhighSettings },
    ).args;
    expect(resumed.slice(-2)).toEqual(["--effort", "max"]);

    const role = roleLaunchArgs("claude", {
      promptFile: "/tmp/p.md",
      mcpJsonPath: "/tmp/m.json",
      model: "opus[1m]",
      claudeSettings: xhighSettings,
    }).args;
    expect(role.slice(-4)).toEqual(["--model", "opus[1m]", "--effort", "max"]);
  });

  it("WI-10005900: claude argv stays byte-identical when there is nothing to clamp", () => {
    // No settings supplied: the pre-WI-10005900 argv.
    expect(modelArgsFor("claude", "opus[1m]")).toEqual(["--model", "opus[1m]"]);
    expect(modelArgsFor("claude", null)).toEqual([]);
    expect(suWrapperExtraArgs("claude", {})).toEqual([]);
    // A model-less non-claude launch still emits nothing (and never resolves a default).
    expect(suWrapperExtraArgs("omp", {})).toEqual(["--no-title"]);
    // An explicit effort wins; supported or non-Opus-5 inherited levels pass through.
    expect(
      modelArgsFor("claude", "opus:high", {
        claudeSettings: { model: "opus", effortLevel: "xhigh" },
      }),
    ).toEqual(["--model", "opus", "--effort", "high"]);
    expect(
      modelArgsFor("claude", "opus[1m]", {
        claudeSettings: { effortLevel: "max" },
      }),
    ).toEqual(["--model", "opus[1m]"]);
    expect(
      modelArgsFor("claude", "claude-sonnet-5", {
        claudeSettings: { effortLevel: "xhigh" },
      }),
    ).toEqual(["--model", "claude-sonnet-5"]);
    // Codex and OMP ignore claude settings entirely.
    expect(
      modelArgsFor("omp", "opus:high", {
        claudeSettings: { model: "opus", effortLevel: "xhigh" },
      }),
    ).toEqual(modelArgsFor("omp", "opus:high"));
  });

  it("WI-10005900: readClaudeLaunchSettings reads the settings the child will read, fail-open", () => {
    const files: Record<string, string> = {
      "/iso/settings.json": JSON.stringify({ model: "opus[1m]", effortLevel: "xhigh", theme: "dark" }),
      "/h/.claude/settings.json": JSON.stringify({ model: "sonnet", effortLevel: "high" }),
    };
    const readFile = (p: string) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return files[p];
    };
    // The per-session isolated CLAUDE_CONFIG_DIR wins over ~/.claude.
    expect(
      readClaudeLaunchSettings({ CLAUDE_CONFIG_DIR: "/iso" }, { home: "/h", readFile }),
    ).toEqual({ model: "opus[1m]", effortLevel: "xhigh" });
    expect(readClaudeLaunchSettings({}, { home: "/h", readFile })).toEqual({
      model: "sonnet",
      effortLevel: "high",
    });
    // ANTHROPIC_MODEL outranks settings.model, as in the CLI.
    expect(
      readClaudeLaunchSettings(
        { CLAUDE_CONFIG_DIR: "/iso", ANTHROPIC_MODEL: "claude-sonnet-5" },
        { home: "/h", readFile },
      ),
    ).toEqual({ model: "claude-sonnet-5", effortLevel: "xhigh" });
    // Missing or malformed settings never fail a launch.
    expect(
      readClaudeLaunchSettings({ CLAUDE_CONFIG_DIR: "/missing" }, { home: "/h", readFile }),
    ).toBeNull();
    expect(
      readClaudeLaunchSettings({}, { home: "/h", readFile: () => "{not json" }),
    ).toBeNull();
    // A programming error is not "no settings": it must surface, not fail open.
    expect(() =>
      readClaudeLaunchSettings({}, {
        home: "/h",
        readFile: () => {
          throw new ReferenceError("readFileSync is not defined");
        },
      }),
    ).toThrow(ReferenceError);
  });

  it("WI-10005900: readClaudeLaunchSettings reads a real isolated settings.json through its default reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi5900-claude-config-"));
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ model: "opus[1m]", effortLevel: "xhigh" }),
      );
      const settings = readClaudeLaunchSettings({ CLAUDE_CONFIG_DIR: dir });
      expect(settings).toEqual({ model: "opus[1m]", effortLevel: "xhigh" });
      expect(modelArgsFor("claude", null, { claudeSettings: settings })).toEqual([
        "--effort",
        "max",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumeArgsFor threads a model into each backend resume — codex flags BEFORE the subcommand", () => {
    expect(
      resumeArgsFor(
        { agent: "claude", sessionId: "uuid-1" },
        { model: "fable:high" },
      ).args,
    ).toEqual([
      "--resume",
      "uuid-1",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
      NATIVE_DEADWEIGHT_DENY_FLAG,
      NO_CHROME_FLAG,
      "--model",
      "fable",
      "--effort",
      "high",
    ]);
    // codex `-m`/`-c` are TOP-LEVEL options — after the `resume` subcommand they'd
    // be parsed as resume's own args and fail the launch.
    expect(
      resumeArgsFor(
        { agent: "codex", sessionId: "uuid-2" },
        { model: "gpt-5.6-sol:high" },
      ).args,
    ).toEqual([
      "--dangerously-bypass-hook-trust",
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      // The window pair rides the RESUME too, and stays ahead of the subcommand
      // with the other top-level options (plan codex-1m D-002 / P-002).
      ...codexContextConfigArgs("gpt-5.6-sol"),
      "resume",
      "uuid-2",
    ]);
    expect(
      resumeArgsFor(
        { agent: "omp", ompThreadId: "thr-1" },
        { model: "opus:high" },
      ).args,
    ).toEqual([
      "-r",
      "thr-1",
      "--approval-mode",
      "yolo",
      "--model",
      "opus:high",
      "--no-title",
    ]);
    // No model → byte-identical to the pre-WI-3758 args (the agent-default path).
    expect(
      resumeArgsFor({ agent: "claude", sessionId: "uuid-1" }).args,
    ).not.toContain("--model");
  });

  describe("lastActiveModelFor (tail-read the session transcript)", () => {
    const UUID = "0123abcd-1234-5678-9abc-def012345678";
    let home = "";
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "psu-lastmodel-"));
    });
    afterEach(() => {
      if (home) rmSync(home, { recursive: true, force: true });
    });

    const writeJsonl = (file: string, lines: unknown[]) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(
        file,
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
    };

    it("claude: the NEWEST assistant model wins; <synthetic> (error events) is skipped", () => {
      const owner = "su-owner-1";
      const f = join(
        home,
        ".papercusp",
        "session-claude",
        owner,
        "projects",
        "-some-dir",
        `${UUID}.jsonl`,
      );
      writeJsonl(f, [
        { type: "user", message: { content: "hi" } },
        {
          type: "assistant",
          message: { model: "claude-fable-5-20260101", content: [] },
        },
        {
          type: "assistant",
          message: { model: "claude-fable-5-20260415", content: [] },
        },
        { type: "assistant", message: { model: "<synthetic>", content: [] } },
      ]);
      expect(
        lastActiveModelFor(
          { agent: "claude", sessionId: UUID, coordOwnerId: owner },
          { home },
        ),
      ).toBe("claude-fable-5-20260415");
    });

    it("codex: the NEWEST turn_context payload.model wins (tracked per-session CODEX_HOME)", () => {
      const f = join(
        home,
        ".papercusp",
        "su-codex-homes",
        "session-42",
        "sessions",
        "2026",
        "07",
        "09",
        `rollout-2026-07-09T22-08-28-${UUID}.jsonl`,
      );
      writeJsonl(f, [
        {
          type: "session_meta",
          payload: { id: UUID, model_provider: "openai" },
        },
        { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
        { type: "turn_context", payload: { model: "gpt-5.6-lux" } },
        { type: "response_item", payload: { role: "assistant" } },
      ]);
      expect(
        lastActiveModelFor(
          { agent: "codex", id: 42, sessionId: UUID },
          { home },
        ),
      ).toBe("gpt-5.6-lux");
    });

    it("codex: the newest turn_context carries model and effort together", () => {
      const f = join(
        home, ".papercusp", "su-codex-homes", "session-43", "sessions",
        "2026", "09", "27", `rollout-2026-09-27T03-00-00-${UUID}.jsonl`,
      );
      writeJsonl(f, [
        { type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "medium" } },
        { type: "turn_context", payload: { model: "gpt-6-astra", effort: "xhigh" } },
      ]);
      expect(lastActiveModelFor({ agent: "codex", id: 43, sessionId: UUID }, { home }))
        .toBe("gpt-6-astra:xhigh");
      expect(resumeTargetSelectionFromLastActive(
        { agent: "codex", launchArgv: ["--model=gpt-5.6-sol:medium"] },
        { picker: false },
        lastActiveModelFor({ agent: "codex", id: 43, sessionId: UUID }, { home }),
      )).toMatchObject({ modelSpec: "gpt-6-astra:xhigh", modelSource: "inherited" });
    });

    it.each([0, 800 * 1024])("codex: carry keeps an in-session model switch after %i bytes of tool output", (paddingBytes) => {
      const codexHome = join(home, ".papercusp", "su-codex-homes", "session-44");
      const file = join(codexHome, "sessions", "2026", "09", "30",
        `rollout-2026-09-30T16-59-38-${UUID}.jsonl`);
      writeJsonl(file, [
        { type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "medium" } },
        { type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "xhigh" } },
        { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(paddingBytes) } },
      ]);
      writeFileSync(join(codexHome, "config.toml"),
        'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n[features]\n');
      writeFileSync(join(codexHome, "AGENTS.md"), "# Base persona\n");
      const inherited = ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"'];
      const detected = detectRespawnModelSpec(inherited, {
        agent: "codex", codexHome, advSessionId: 44, home,
        modelSource: "configured-default",
      });
      expect(detected).toBe("gpt-6.1-sol:xhigh");
      for (const subcommand of [[], ["resume", UUID], ["fork", UUID]]) {
        const carry = mintCarryRespawnArgs([...inherited, ...subcommand], {
          agent: "codex", codexHome, home, ownerId: "su-model-carry-regression",
          model: detected, systemPromptAddendum: "Continue the checkpointed work.",
        });
        expect(modelSpecFromRecycleArgv(carry.args)).toBe("gpt-6.1-sol:xhigh");
        expect(carry.args).not.toContain("gpt-5.6-sol");
        expect(carry.args).not.toContain("resume");
        expect(carry.args).not.toContain("fork");
      }
    });

    it.each([
      { name: "older turn", timestamp: "2026-10-01T12:55:00.000Z" },
      { name: "undated turn", timestamp: undefined },
      { name: "invalid timestamp", timestamp: "not-a-time" },
    ])("codex: carry ignores pre-launch models from an $name", ({ timestamp }) => {
      const codexHome = join(home, ".papercusp", "su-codex-homes", "session-46");
      const file = join(codexHome, "sessions", "2026", "10", "01",
        `rollout-2026-10-01T12-00-00-${UUID}.jsonl`);
      writeJsonl(file, [
        { type: "turn_context", timestamp, payload: { model: "gpt-5.6-sol", effort: "xhigh" } },
        { type: "response_item", payload: { output: "The restored session appended new metadata." } },
      ]);
      writeFileSync(join(codexHome, "config.toml"),
        'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n[features]\n');
      writeFileSync(join(codexHome, "AGENTS.md"), "# Base persona\n");
      const inherited = ["-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"', "resume", UUID];
      const opts = {
        agent: "codex", codexHome, advSessionId: 46, home, modelSource: "explicit",
        notBeforeMs: Date.parse("2026-10-01T13:01:00.000Z"),
      };
      expect(lastActiveModelFor({ agent: "codex", id: 46, sessionId: UUID }, { home }))
        .toBe("gpt-5.6-sol:xhigh");
      const selected = detectRespawnModelSpec(inherited, opts);
      expect(selected).toBeNull();
      expect(detectRespawnModelSpec(inherited, { ...opts, includeInherited: true }))
        .toBe("gpt-6.1-sol:xhigh");
      expect(modelSpecFromRecycleArgv(mintCarryRespawnArgs(inherited, {
        agent: "codex", codexHome, home, model: selected,
        systemPromptAddendum: "Continue the checkpointed session.",
      }).args)).toBe("gpt-6.1-sol:xhigh");
    });

    it.each([
      { model: "gpt-5.6-sol", effort: "xhigh" },
      { model: "gpt-6.1-sol", effort: "medium" },
    ])("codex: carry honors a post-launch switch to $model:$effort", ({ model, effort }) => {
      const codexHome = join(home, ".papercusp", "su-codex-homes", "session-47");
      const file = join(codexHome, "sessions", "2026", "10", "01",
        `rollout-2026-10-01T12-00-00-${UUID}.jsonl`);
      writeJsonl(file, [
        { type: "turn_context", timestamp: "2026-10-01T12:55:00.000Z",
          payload: { model: "gpt-5.6-sol", effort: "low" } },
        { type: "turn_context", timestamp: "2026-10-01T13:02:00.000Z", payload: { model, effort } },
      ]);
      const selected = detectRespawnModelSpec(
        ["-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"'],
        { agent: "codex", codexHome, advSessionId: 47, home, modelSource: "explicit",
          notBeforeMs: Date.parse("2026-10-01T13:01:00.000Z") },
      );
      expect(selected).toBe(`${model}:${effort}`);
    });

    it("codex: reconstructs a model record spanning read chunks, including multibyte text", () => {
      const file = join(home, ".papercusp", "su-codex-homes", "session-45", "sessions",
        "2026", "09", "30", `rollout-2026-09-30T17-00-00-${UUID}.jsonl`);
      writeJsonl(file, [
        { type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "medium" } },
        { type: "turn_context", payload: {
          model: "gpt-6.1-sol", effort: "xhigh", instructions: "é".repeat(300 * 1024),
        } },
        { type: "response_item", payload: { output: "y".repeat(400 * 1024) } },
      ]);
      expect(lastActiveModelFor({ agent: "codex", id: 45, sessionId: UUID }, { home }))
        .toBe("gpt-6.1-sol:xhigh");
    });

    it("codex: an UNTRACKED session (no adv row id) falls back to the shared ~/.codex store", () => {
      const f = join(
        home,
        ".codex",
        "sessions",
        "2026",
        "07",
        "10",
        `rollout-2026-07-10T00-00-00-${UUID}.jsonl`,
      );
      writeJsonl(f, [
        { type: "session_meta", payload: { id: UUID } },
        { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      ]);
      expect(
        sessionTranscriptFile(
          { agent: "codex", id: null, sessionId: UUID },
          { home },
        ),
      ).toBe(f);
      expect(
        lastActiveModelFor(
          { agent: "codex", id: null, sessionId: UUID },
          { home },
        ),
      ).toBe("gpt-5.6-sol");
    });

    it("omp: the newest model_change wins from the tracked per-session store", () => {
      const threadId = "omp-thread-7";
      const f = join(
        home,
        ".papercusp",
        "su-omp-homes",
        "session-42",
        "agent",
        "sessions",
        "project",
        `2026-07-16T00-00-00_${threadId}.jsonl`,
      );
      writeJsonl(f, [
        { type: "session", id: threadId },
        { type: "model_change", model: "anthropic/claude-sonnet-4-6" },
        { type: "model_change", model: "papercusp-gateway/claude-opus-4-8" },
      ]);
      expect(
        sessionTranscriptFile(
          { agent: "omp", id: 42, ompThreadId: threadId },
          { home },
        ),
      ).toBe(f);
      expect(
        lastActiveModelFor(
          { agent: "omp", id: 42, ompThreadId: threadId },
          { home },
        ),
      ).toBe("papercusp-gateway/claude-opus-4-8");
    });

    it("degrades to null for a missing transcript or a transcript with no model events", () => {
      expect(
        lastActiveModelFor({ agent: "omp", ompThreadId: "t-1" }, { home }),
      ).toBe(null);
      expect(
        lastActiveModelFor(
          { agent: "claude", sessionId: UUID, coordOwnerId: "su-none" },
          { home },
        ),
      ).toBe(null);
      const owner = "su-owner-2";
      const f = join(
        home,
        ".papercusp",
        "session-claude",
        owner,
        "projects",
        "-d",
        `${UUID}.jsonl`,
      );
      writeJsonl(f, [{ type: "user", message: { content: "hi" } }]);
      expect(
        lastActiveModelFor(
          { agent: "claude", sessionId: UUID, coordOwnerId: owner },
          { home },
        ),
      ).toBe(null);
    });
  });
});

describe("resumeSessionLineageLabel", () => {
  it("labels a delivered port without exposing transcript content", () => {
    expect(
      resumeSessionLineageLabel({
        portSourceAdvSessionId: 42,
        portStatus: "delivered",
      }),
    ).toBe("ported from #42");
  });

  it("surfaces a non-delivered lifecycle state and ignores native sessions", () => {
    expect(
      resumeSessionLineageLabel({
        portSourceAdvSessionId: 42,
        portStatus: "failed",
      }),
    ).toBe("ported from #42 (failed)");
    expect(
      resumeSessionLineageLabel({ portSourceAdvSessionId: null }),
    ).toBeNull();
  });
});

describe("reportSessionEnded (acknowledged idempotent eligibility transition)", () => {
  it("POSTs the row id + exit code to bootstrap-su/session-ended with the bearer", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    await reportSessionEnded("17", 0, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "tok-1",
      endAttemptKey: "end-attempt-17",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://op:1/api/agent-mcp/console/bootstrap-su/session-ended",
    );
    expect(calls[0].opts.headers.authorization).toBe("Bearer tok-1");
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      advSessionId: 17,
      exitCode: 0,
      killedBySignal: null,
      endAttemptKey: "end-attempt-17",
      // WI-10002854: the observation time rides the report so the server can refuse to
      // end a successor incarnation that started after it.
      observedAt: expect.any(String),
    });
  });

  it("a REPLAYED witness reports its ORIGINAL observation time, not the replay time (WI-10002854)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const home = mkdtempSync(joinPath(tmpdir(), "wi10002854-"));
    const bodies = [];
    const fetchImpl = async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true };
    };
    const original = "2026-09-24T01:02:05.000Z";
    await reportSessionEnded("29830", null, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "tok-1",
      endAttemptKey: "end-attempt-29830",
      observedAt: original,
      now: () => Date.parse("2026-09-24T01:04:40.000Z"),
      home,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].observedAt).toBe(original);
    // A missing/garbled original falls back to the current clock rather than dropping the field.
    await reportSessionEnded("29830", null, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "tok-1",
      endAttemptKey: "end-attempt-29830-b",
      observedAt: "not-a-date",
      now: () => Date.parse("2026-09-24T01:04:40.000Z"),
      home,
    });
    expect(bodies[1].observedAt).toBe("2026-09-24T01:04:40.000Z");
  });

  it("retries a proxy-shed end transition with the SAME idempotency key", async () => {
    const calls: Array<{ endAttemptKey: string }> = [];
    let now = 0;
    const fetchImpl: typeof fetch = async (_url, opts) => {
      calls.push(JSON.parse(String(opts?.body)));
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: "mcp_proxy_overloaded" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "2" },
        });
      }
      return Response.json({ ok: true, ended: true });
    };

    await expect(
      reportSessionEnded(17, 0, {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
        endAttemptKey: "end-attempt-replay-17",
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    ).resolves.toMatchObject({ reported: true });
    expect(calls).toEqual([
      expect.objectContaining({ endAttemptKey: "end-attempt-replay-17" }),
      expect.objectContaining({ endAttemptKey: "end-attempt-replay-17" }),
    ]);
  });

  it("maps a null/undefined exit code to null (signal exits)", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    await reportSessionEnded(17, undefined, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
      endAttemptKey: "end-undefined-17",
    });
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      advSessionId: 17,
      exitCode: null,
      killedBySignal: null,
      endAttemptKey: "end-undefined-17",
      observedAt: expect.any(String),
    });
  });

  // WI-38054 — the field that decides whether the server records a voluntary exit or a
  // kill. A killed session reports exitCode 0 (node-pty's placeholder), so if this does
  // not travel, the row asserts a clean exit and a reap becomes undetectable.
  it("forwards the killing signal, so exit 0 cannot be read as a clean exit", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    await reportSessionEnded(17, 0, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
      killedBySignal: "SIGHUP",
      endAttemptKey: "end-signal-17",
    });
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      advSessionId: 17,
      exitCode: 0,
      killedBySignal: "SIGHUP",
      endAttemptKey: "end-signal-17",
      observedAt: expect.any(String),
    });
  });

  it("marks a claimed resume launch failure explicitly, without inventing a signal", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    await reportSessionEnded(17, null, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
      launchFailed: true,
      endAttemptKey: "end-cleanup-17",
    });
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      advSessionId: 17,
      exitCode: null,
      killedBySignal: null,
      launchFailed: true,
      endAttemptKey: "end-cleanup-17",
      observedAt: expect.any(String),
    });
  });

  it("sends killedBySignal: null for an ordinary exit — never omits the key", async () => {
    // Omitting it would be indistinguishable, server-side, from an older launcher that
    // cannot report signals at all. Always stating it keeps "no signal" an assertion
    // rather than an absence.
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    await reportSessionEnded(17, 0, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    expect(JSON.parse(calls[0].opts.body)).toHaveProperty(
      "killedBySignal",
      null,
    );
  });

  it("no adv row id → no request (untracked sessions have nothing to stamp)", async () => {
    const calls = [];
    const fetchImpl = async (...a) => {
      calls.push(a);
      return { ok: true };
    };
    await reportSessionEnded(null, 0, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["malformed JSON", "{broken-json"],
    ["JSON null", "null"],
    ["an unrelated object", "{}"],
    ["a refusal", '{"ok":false}'],
  ])("retains the end witness for %s and replays its original observation", async (_label, responseBody) => {
    const home = mkdtempSync(join(tmpdir(), "psu-end-invalid-ack-"));
    const observedAt = "2026-10-16T12:01:48.000Z";
    const bodies: Array<{ endAttemptKey: string; observedAt: string }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(bodies.length === 1 ? responseBody : '{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const options = {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
      endAttemptKey: "end-invalid-ack-17",
      observedAt,
      home,
    };
    try {
      await expect(reportSessionEnded(17, 1, options)).resolves.toMatchObject({
        reported: false,
        reason: "http",
        status: 200,
      });
      const pending = readPendingSessionEndWitness(17, home);
      expect(pending).toMatchObject({
        advSessionId: 17,
        endAttemptKey: options.endAttemptKey,
        observedAt,
      });
      // Only a real acknowledgement may remove the witness; replay retains
      // the original observation so it cannot re-end a newer incarnation.
      await expect(reportSessionEnded(17, 1, {
        ...options,
        endAttemptKey: pending.endAttemptKey,
        observedAt: pending.observedAt,
      })).resolves.toMatchObject({ reported: true });
      expect(bodies).toEqual([
        expect.objectContaining({ endAttemptKey: options.endAttemptKey, observedAt }),
        expect.objectContaining({ endAttemptKey: options.endAttemptKey, observedAt }),
      ]);
      expect(existsSync(pendingSessionEndWitnessPath(17, home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns a transport outcome and keeps the pending witness when acknowledgement fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "psu-end-witness-"));
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      reportSessionEnded(17, 1, {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
        endAttemptKey: "end-transport-17",
        connectBudgetMs: 0,
        timeoutRetries: 0,
        home,
      }),
    ).resolves.toMatchObject({ reported: false, reason: "transport" });
    expect(readPendingSessionEndWitness(17, home)).toMatchObject({
      advSessionId: 17,
      endAttemptKey: "end-transport-17",
    });
    expect(existsSync(pendingSessionEndWitnessPath(17, home))).toBe(true);
  });
});

describe("startSupervisorBeat (WI-3898 P1: the beat self-reports its own pid/host)", () => {
  it("an attached host reports its engine child's pid", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    startSupervisorBeat("su-attached", {
      pid: 4321,
      fetchImpl,
      token: "fixture",
      setIntervalImpl: () => ({ unref() {} }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ ownerId: "su-attached", pid: 4321 });
  });

  it("the immediate first beat POSTs { ownerId, pid: process.pid, host: hostname() }", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    const fakeTimer = { unref: () => {} };
    startSupervisorBeat("su-abc", {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
      setIntervalImpl: () => fakeTimer,
    });
    // startSupervisorBeat fires an immediate `void beat()` (fire-and-forget)
    // before returning — flush a microtask so it lands before we assert.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://op:1/api/agent-mcp/console/bootstrap-su/heartbeat",
    );
    const body = JSON.parse(calls[0].opts.body);
    expect(body).toEqual({
      ownerId: "su-abc",
      pid: process.pid,
      host: hostname(),
    });
  });

  it("returns null and never beats when ownerId is falsy", () => {
    const calls = [];
    const fetchImpl = async (...a) => {
      calls.push(a);
      return { ok: true };
    };
    const timer = startSupervisorBeat("", {
      fetchImpl,
      setIntervalImpl: () => ({ unref: () => {} }),
    });
    expect(timer).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("schedules the recurring beat on the injected interval (same pid/host body each tick)", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    let tickFn;
    const setIntervalImpl = (fn) => {
      tickFn = fn;
      return { unref: () => {} };
    };
    startSupervisorBeat("su-abc", {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
      setIntervalImpl,
    });
    await new Promise((r) => setTimeout(r, 0)); // the immediate beat
    expect(calls).toHaveLength(1);
    tickFn(); // simulate one interval tick
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].opts.body)).toEqual(
      JSON.parse(calls[0].opts.body),
    );
  });
});

/**
 * Narrow a ResumeClaimOutcome to its REFUSED branch. `reportSessionResumed`
 * returns a discriminated union, so `.reason`/`.detail` do not exist on the
 * claimed branch; an `expect(...).toBe(false)` does not narrow for the compiler.
 * Throwing here also makes an unexpectedly-SUCCESSFUL claim fail loudly instead
 * of silently reading `undefined` off the wrong branch.
 */
function refusalOf(outcome: Awaited<ReturnType<typeof reportSessionResumed>>) {
  if (outcome.claimed) {
    throw new Error("expected the resume claim to be REFUSED, but it was granted");
  }
  return outcome;
}

describe("Codex resume local-liveness evidence", () => {
  const canonical = {
    version: 1,
    kind: "no-live-codex-writer",
  };

  it("normalizes only the exact closed positive witness", () => {
    expect(NO_LIVE_CODEX_WRITER_EVIDENCE).toEqual(canonical);
    expect(normalizeResumeLocalLivenessEvidence(canonical)).toEqual(canonical);
    expect(normalizeResumeLocalLivenessEvidence(canonical)).not.toBe(canonical);

    for (const value of [
      null,
      undefined,
      [],
      { version: 1, kind: "no-live-codex-writer", extra: true },
      { version: "1", kind: "no-live-codex-writer" },
      { version: 1, kind: "free" },
    ]) {
      expect(normalizeResumeLocalLivenessEvidence(value)).toBeNull();
    }
  });

  it("emits the witness only for a non-fork Codex with both positive local oracles", () => {
    expect(
      normalizeCodexResumeLocalLivenessEvidence({
        agent: "codex",
        fork: false,
        forceResume: undefined,
        liveHost: null,
        writerHolder: { held: false, reason: "free" },
      }),
    ).toEqual(canonical);
    expect(
      normalizeCodexResumeLocalLivenessEvidence({
        agent: "codex",
        fork: false,
        forceResume: undefined,
        liveHost: null,
        writerHolder: { held: false, reason: "no-lock-file" },
      }),
    ).toEqual(canonical);

    for (const value of [
      { agent: "claude", liveHost: null, writerHolder: { held: false, reason: "free" } },
      { agent: "omp", liveHost: null, writerHolder: { held: false, reason: "free" } },
      { agent: "codex", fork: true, liveHost: null, writerHolder: { held: false, reason: "free" } },
      { agent: "codex", forceResume: "1", liveHost: null, writerHolder: { held: false, reason: "free" } },
      { agent: "codex", liveHost: {}, writerHolder: { held: false, reason: "free" } },
      { agent: "codex", liveHost: null, writerHolder: { held: true, reason: "held" } },
      { agent: "codex", liveHost: null, writerHolder: { held: false, reason: "unknown" } },
      { agent: "codex", liveHost: null, writerHolder: null },
    ]) {
      expect(normalizeCodexResumeLocalLivenessEvidence(value)).toBeNull();
    }
  });
});

describe("WI-2141892 — Claude resume local-liveness evidence", () => {
  const canonical = { version: 1, kind: "no-live-claude-process" };

  // A `/proc` the probe can be pointed at without touching the real one.
  const fakeProc = ({ pids, cmdlines, parents = {} }) => ({
    listProcPids: () => pids,
    readCmdline: (pid) => {
      if (!(pid in cmdlines)) throw new Error(`ESRCH ${pid}`);
      return cmdlines[pid];
    },
    readStat: (pid) => `${pid} (node) S ${parents[pid] ?? 0} 0 0`,
  });

  it("normalizes the claude witness alongside the codex one, and nothing else", () => {
    expect(NO_LIVE_CLAUDE_PROCESS_EVIDENCE).toEqual(canonical);
    expect(normalizeResumeLocalLivenessEvidence(canonical)).toEqual(canonical);
    // A fresh object every time: a shared frozen singleton on the wire would let
    // one caller's mutation reach another's payload.
    expect(normalizeResumeLocalLivenessEvidence(canonical)).not.toBe(canonical);

    for (const value of [
      { version: 1, kind: "no-live-claude-process", extra: true },
      { version: 2, kind: "no-live-claude-process" },
      { version: 1, kind: "no-live-claude-writer" },
      { version: 1, kind: "clean-scan" },
    ]) {
      expect(normalizeResumeLocalLivenessEvidence(value)).toBeNull();
    }
  });

  it("reports a live holder when another process carries the session id", () => {
    const holder = sessionProcessHolder("sess-abc", {
      ...fakeProc({
        pids: [10, 11],
        cmdlines: { 10: "claude --resume sess-abc", 11: "unrelated" },
      }),
      selfPid: 11,
    });
    expect(holder).toMatchObject({ held: true, pid: 10, reason: "argv-match" });
  });

  it("ignores an unrelated transport shell whose single argument contains the resume request", () => {
    const id = "484dad61-fef2-4dd0-86e2-468a8bf41967";
    const command = `ptool capability:launch-agent --json - <<'JSON'\n${JSON.stringify({ resume: { sessionId: id } })}\nJSON`;
    const proc = fakeProc({
      pids: [10, 11],
      cmdlines: {
        10: ["bash", "-c", command, ""].join("\0"),
        11: ["node", "ptool.mjs", "--brief", `Review transcript ${id}`, ""].join("\0"),
      },
    });
    expect(sessionProcessHolder(id, { ...proc, selfPid: 99 })).toMatchObject({
      held: false,
      reason: "clean-scan",
    });
  });

  it("still detects exact native resume and session-id arguments outside the caller ancestry", () => {
    const id = "484dad61-fef2-4dd0-86e2-468a8bf41967";
    for (const argv of [
      ["claude", "--resume", id],
      ["claude", `--resume=${id}`],
      ["claude", "--session-id", id],
      ["claude", `--session-id=${id}`],
      ["node", "omp", "-r", id],
    ]) {
      expect(sessionProcessHolder(id, {
        ...fakeProc({ pids: [10], cmdlines: { 10: [...argv, ""].join("\0") } }),
        selfPid: 99,
      })).toMatchObject({ held: true, pid: 10, reason: "argv-match" });
    }
    expect(sessionProcessHolder(id, {
      ...fakeProc({ pids: [10], cmdlines: { 10: ["claude", "--resume", `${id}-other`, ""].join("\0") } }),
      selfPid: 99,
    })).toMatchObject({ held: false, reason: "clean-scan" });
  });

  it("EXCLUDES the caller's whole ancestor chain, not just its own pid", () => {
    // The trap this guard exists for: psu's own argv carries `--resume <uuid>`,
    // and so does the shell that launched it. pid 12 is the probe, 11 its
    // parent, 10 its grandparent — all three name the session.
    const proc = fakeProc({
      pids: [10, 11, 12],
      cmdlines: {
        10: "bash -c psu --resume sess-abc",
        11: "psu --resume sess-abc",
        12: "node psu-launcher --resume sess-abc",
      },
      parents: { 12: 11, 11: 10, 10: 1 },
    });
    expect(
      sessionProcessHolder("sess-abc", { ...proc, selfPid: 12 }),
    ).toMatchObject({ held: false, reason: "clean-scan" });

    // POSITIVE CONTROL — without the ancestor walk the very same scan reports a
    // holder, so the assertion above is not passing for a trivial reason.
    expect(
      sessionProcessHolder("sess-abc", {
        ...proc,
        readStat: () => {
          throw new Error("no chain");
        },
        selfPid: 12,
      }),
    ).toMatchObject({ held: true, reason: "argv-match" });
  });

  it("fails CLOSED on every probe failure — an unknown scan is not an absence", () => {
    // The opposite of the codex writer-lock probe: that one may only improve a
    // message, this one RELAXES a guard, so it may never guess.
    expect(sessionProcessHolder("", {})).toMatchObject({
      held: false,
      reason: "no-session-id",
    });
    expect(
      sessionProcessHolder("sess-abc", {
        listProcPids: () => {
          throw new Error("no /proc");
        },
      }),
    ).toMatchObject({ held: false, reason: "no-proc" });
    expect(
      sessionProcessHolder("sess-abc", { listProcPids: () => [] }),
    ).toMatchObject({ held: false, reason: "scan-empty" });

    // Only "clean-scan" is a witness; the other three false results are unknown.
    for (const reason of ["no-session-id", "no-proc", "scan-empty"]) {
      expect(
        normalizeArgvProbeResumeLocalLivenessEvidence({
          agent: "claude",
          liveHost: null,
          processHolder: { held: false, reason },
        }),
      ).toBeNull();
    }
  });

  it("lists /proc by name, so a pid exiting mid-listing cannot fail the scan", () => {
    // EI-24661719545676832: `withFileTypes` makes Node lstat() entries, and a
    // pid that exits between getdents() and that lstat() throws ENOENT for the
    // WHOLE listing — refusing a recoverable resume as probe=no-proc. This
    // readdir behaves like that: typed listings race, name listings do not.
    const calls: unknown[] = [];
    const racyReaddir = (path: string, options?: unknown) => {
      calls.push(options);
      if (options !== undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}/4084343'`), {
          code: "ENOENT",
        });
      }
      return ["1", "self", "4084343", "sys", "77"];
    };
    expect(listProcPids({ readdir: racyReaddir })).toEqual([1, 4084343, 77]);
    expect(calls).toEqual([undefined]);

    // The real /proc, as a positive control that the default reads this host.
    expect(listProcPids().length).toBeGreaterThan(0);
  });

  it("carries the listing's errno into a no-proc miss", () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(`${code}: too many open files, scandir '/proc'`), { code });
    };
    expect(sessionProcessHolder("sess-abc", { listProcPids: fail("EMFILE") })).toEqual({
      held: false, pid: null, cmdline: null, reason: "no-proc", error: "EMFILE",
    });
    // No code, or a non-errno value: the reason alone, never the message.
    expect(
      sessionProcessHolder("sess-abc", {
        listProcPids: () => {
          throw new Error("/proc listed no pids");
        },
      }),
    ).toEqual({ held: false, pid: null, cmdline: null, reason: "no-proc" });
  });

  it("skips a pid that exits mid-scan rather than calling it a holder", () => {
    // A read error on one pid must not make the witness unobtainable on a busy
    // box — that pid is gone, which is the opposite of holding the session.
    expect(
      sessionProcessHolder("sess-abc", {
        ...fakeProc({ pids: [10, 11], cmdlines: { 11: "unrelated" } }),
        selfPid: 99,
      }),
    ).toMatchObject({ held: false, reason: "clean-scan" });
  });

  it("emits the witness only for a non-fork Claude with both positive oracles", () => {
    expect(
      normalizeArgvProbeResumeLocalLivenessEvidence({
        agent: "claude",
        fork: false,
        forceResume: undefined,
        liveHost: null,
        processHolder: { held: false, reason: "clean-scan" },
      }),
    ).toEqual(canonical);

    const clean = { held: false, reason: "clean-scan" };
    for (const value of [
      // wrong backend — codex does NOT probe argv: it has its own writer-lock
      // oracle, and the two ask different questions. (omp was here until
      // WI-2142101; it is now a legitimate argv-probe backend, asserted above.)
      { agent: "codex", liveHost: null, processHolder: clean },
      { agent: "gemini", liveHost: null, processHolder: clean },
      { agent: null, liveHost: null, processHolder: clean },
      // a fork needs no witness: it never reuses the identity
      { agent: "claude", fork: true, liveHost: null, processHolder: clean },
      // a force means "take over a host I can SEE" — it must not manufacture an
      // absence claim the probe did not make
      { agent: "claude", forceResume: "1", liveHost: null, processHolder: clean },
      // a live PTY host is the first oracle saying no
      { agent: "claude", liveHost: {}, processHolder: clean },
      // the PTY-host oracle never ran (undefined, not null)
      { agent: "claude", processHolder: clean },
      { agent: "claude", liveHost: null, processHolder: { held: true, reason: "argv-match" } },
      { agent: "claude", liveHost: null, processHolder: null },
      { agent: "claude", liveHost: null, processHolder: [] },
    ]) {
      expect(normalizeArgvProbeResumeLocalLivenessEvidence(value)).toBeNull();
    }
  });

  it("degrades to the pre-witness claim when the operator 400s an unknown kind", async () => {
    // MIXED-VERSION ROLLOUT, measured 2026-09-02: `psu` execs this launcher
    // straight from the staging checkout, while :3070/:3170/:3270 all still
    // rejected `no-live-claude-process`. Without this fallback, teaching the
    // launcher a new kind makes the very bug being fixed strictly WORSE — the
    // owner's refusal becomes "operator returned HTTP 400" until a deploy lands.
    const bodies: any[] = [];
    const notices: string[] = [];
    const fetchImpl = async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (body.localLivenessEvidence) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "unknown kind" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, acquired: true, status: "acquired" }),
      };
    };

    const outcome = await reportSessionResumed(22127, {
      fetchImpl,
      token: "t",
      resumeClaimKey: "claim-rollout",
      localLivenessEvidence: { version: 1, kind: "no-live-claude-process" },
      onNotice: (m: string) => notices.push(m),
    });

    expect(outcome).toMatchObject({ claimed: true, status: "acquired" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].localLivenessEvidence).toEqual({
      version: 1,
      kind: "no-live-claude-process",
    });
    // The retry is the OLD request, not a new shape...
    expect(bodies[1].localLivenessEvidence).toBeUndefined();
    // ...on the SAME key, so the endpoint's replay contract cannot mint a
    // second claimant.
    expect(bodies[1].resumeClaimKey).toBe("claim-rollout");
    expect(notices.join("")).toContain("no-live-claude-process");
  });

  it("does NOT retry a 400 that was not caused by the witness", async () => {
    // POSITIVE CONTROL for the fallback's narrowness: a 400 on a request that
    // carried no witness must surface as today's http refusal, not loop.
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: false, status: 400, json: async () => ({}) };
    };
    const outcome = await reportSessionResumed(22127, {
      fetchImpl,
      token: "t",
      resumeClaimKey: "claim-plain-400",
      onNotice: () => {},
    });
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ claimed: false, reason: "http" });
  });

  it("WI-2142217 — the 400-degrade is GENERIC over witness kind, not claude-shaped", async () => {
    // The test above proves the fallback for `no-live-claude-process` only, and for a
    // while that was the only kind there was. WI-2142101 added `no-live-omp-process`,
    // and the mixed-version window is WIDEST for a newly-taught kind — the launcher runs
    // from staging, the endpoint is the released green pin, so a brand-new kind is
    // guaranteed to 400 until a deploy lands.
    //
    // The branch keys on `status === 400 && canonicalLocalLivenessEvidence`, never on the
    // kind, so omp is carried correctly by construction. Nothing PINNED that, though, and
    // the plausible future edit is narrowing the condition to the claude kind — it reads
    // like a tightening. Under that edit the claude test above still passes while every
    // omp resume returns an opaque HTTP 400: a silent, backend-specific regression with a
    // fully green suite. This is the test that fails instead.
    const bodies: any[] = [];
    const notices: string[] = [];
    const fetchImpl = async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (body.localLivenessEvidence) {
        return { ok: false, status: 400, json: async () => ({ error: "unknown kind" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, acquired: true, status: "acquired" }),
      };
    };

    const outcome = await reportSessionResumed(22128, {
      fetchImpl,
      token: "t",
      resumeClaimKey: "claim-omp-rollout",
      localLivenessEvidence: NO_LIVE_OMP_PROCESS_EVIDENCE,
      onNotice: (m: string) => notices.push(m),
    });

    expect(outcome).toMatchObject({ claimed: true, status: "acquired" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].localLivenessEvidence).toEqual({
      version: 1,
      kind: "no-live-omp-process",
    });
    // Same contract as the claude path: the retry is the OLD request on the SAME key.
    expect(bodies[1].localLivenessEvidence).toBeUndefined();
    expect(bodies[1].resumeClaimKey).toBe("claim-omp-rollout");
    // The notice must name the kind that was actually rejected, or an owner reading it
    // goes looking at the wrong backend.
    expect(notices.join("")).toContain("no-live-omp-process");
    expect(notices.join("")).not.toContain("no-live-claude-process");
  });

  it("WI-2142101 — mints the OMP witness off omp_thread_id, kept distinct from claude's", () => {
    // resumeArgsFor emits `omp -r <ompThreadId>`, so the id IS on the command
    // line exactly like claude's `--resume <uuid>`; the probe was never
    // claude-specific, only claude-NAMED.
    expect(NO_LIVE_OMP_PROCESS_EVIDENCE).toEqual({
      version: 1,
      kind: "no-live-omp-process",
    });
    expect(
      normalizeArgvProbeResumeLocalLivenessEvidence({
        agent: "omp",
        fork: false,
        forceResume: undefined,
        liveHost: null,
        processHolder: { held: false, reason: "clean-scan" },
      }),
    ).toEqual({ version: 1, kind: "no-live-omp-process" });

    // Each backend mints only ITS OWN kind — the server refuses a cross-applied
    // one, but the launcher must not produce it in the first place.
    expect(
      normalizeArgvProbeResumeLocalLivenessEvidence({
        agent: "claude",
        liveHost: null,
        processHolder: { held: false, reason: "clean-scan" },
      }),
    ).toEqual({ version: 1, kind: "no-live-claude-process" });

    // codex is deliberately NOT an argv-probe backend: it has a better oracle.
    expect(
      normalizeArgvProbeResumeLocalLivenessEvidence({
        agent: "codex",
        liveHost: null,
        processHolder: { held: false, reason: "clean-scan" },
      }),
    ).toBeNull();
  });

  it("reads each backend's id from the column its own resume puts in argv", () => {
    expect(
      argvProbeSessionId({ agent: "claude", sessionId: "sess-1", ompThreadId: "thread-1" }),
    ).toBe("sess-1");
    expect(
      argvProbeSessionId({ agent: "omp", sessionId: "sess-1", ompThreadId: "thread-1" }),
    ).toBe("thread-1");
    // No id recorded ⇒ psu resumes with `--continue` / `-c`, which names nothing
    // to scan for, so the probe must get null and fail closed rather than
    // scanning for an empty string (which matches every process).
    expect(argvProbeSessionId({ agent: "omp", ompThreadId: null })).toBeNull();
    expect(argvProbeSessionId({ agent: "claude", sessionId: "" })).toBeNull();
    expect(argvProbeSessionId({ agent: "codex", sessionId: "sess-1" })).toBeNull();
    expect(argvProbeSessionId({ agent: null })).toBeNull();
  });

  it("WI-2142101 — the omp refusal reports the probe instead of asserting an unmade check", () => {
    const live = { status: "live" } as const;
    // REGRESSION GUARD. The old omp branch asserted "No live managed-PTY host was
    // found before this database check" unconditionally — a claim about a check
    // that had not run. Once claude and codex reported real observations, omp was
    // the only backend whose message could be false.
    const notProbed = describeResumeClaimRefusal(live, { agent: "omp" });
    expect(notProbed).toContain("did not run");
    expect(notProbed).not.toContain("No live managed-PTY host was found");

    // With a real probe result it reports what was actually observed.
    expect(
      describeResumeClaimRefusal(live, {
        agent: "omp",
        processHolder: { held: true, pid: 77, reason: "argv-match" },
      }),
    ).toContain("pid 77");
    expect(
      describeResumeClaimRefusal(live, {
        agent: "omp",
        processHolder: { held: false, reason: "no-proc" },
      }),
    ).toContain("no-proc");

    // Claude takes the same branch, so the two stay consistent by construction.
    expect(describeResumeClaimRefusal(live, { agent: "claude" })).toContain("did not run");
  });

  it("names a route in the refusal instead of only --fork", () => {
    const live = { status: "live" };
    const held = describeResumeClaimRefusal(live, {
      agent: "claude",
      processHolder: { held: true, pid: 4242, reason: "argv-match" },
    });
    expect(held).toContain("pid 4242");
    expect(held).toContain("coord:send");
    expect(held).toContain("processes:kill");

    const unknown = describeResumeClaimRefusal(live, {
      agent: "claude",
      processHolder: { held: false, reason: "no-proc" },
    });
    expect(unknown).toContain("no-proc");
    expect(unknown).toContain("--fork");
    // The owner must be told what --fork COSTS; the old text offered it flatly.
    expect(unknown).toContain("NEW identity");
  });
});

describe("reportSessionResumed (atomic adv-row resume claim — fail closed)", () => {
  it("keeps retired refusal terminal and sends the opt-in only when explicitly true", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, opts) => {
      bodies.push(JSON.parse(String(opts?.body)));
      return Response.json({ ok: true, status: "retired", acquired: false, reactivated: false });
    };
    for (const allowRetired of [undefined, false, true]) {
      await expect(reportSessionResumed(42, { fetchImpl, operatorUrl: "http://op:1", resumeClaimKey: "retired-key", allowRetired })).resolves.toMatchObject({ claimed: false, status: "retired" });
    }
    expect(bodies).toEqual([
      { advSessionId: 42, resumeClaimKey: "retired-key" },
      { advSessionId: 42, resumeClaimKey: "retired-key" },
      { advSessionId: 42, resumeClaimKey: "retired-key", allowRetired: true },
    ]);
  });

  it("uses the shared proxy-derived request budget by default", async () => {
    const timeoutValues: number[] = [];
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        timeoutValues.push(ms);
        return new AbortController().signal;
      });

    try {
      await expect(
        reportSessionResumed(42, {
          fetchImpl: async () =>
            Response.json({
              ok: true,
              status: "acquired",
              acquired: true,
              reactivated: true,
            }),
          operatorUrl: "http://op:1",
          resumeClaimKey: "resume-shared-budget",
        }),
      ).resolves.toMatchObject({ claimed: true, status: "acquired" });
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(timeoutValues).toEqual([PSU_REQUEST_TIMEOUT_MS]);
  });

  it("POSTs the row id to bootstrap-su/session-resumed with the bearer", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          status: "acquired",
          acquired: true,
          replayed: false,
          leaseExpiresAt: "2026-08-26T16:00:00.000Z",
          reactivated: true,
        }),
      };
    };
    await expect(
      reportSessionResumed("42", {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "tok-1",
        resumeClaimKey: "resume-claim-1",
      }),
    ).resolves.toEqual({
      claimed: true,
      status: "acquired",
      resumeClaimKey: "resume-claim-1",
      replayed: false,
      leaseExpiresAt: "2026-08-26T16:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://op:1/api/agent-mcp/console/bootstrap-su/session-resumed",
    );
    expect(calls[0].opts.headers.authorization).toBe("Bearer tok-1");
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      advSessionId: 42,
      resumeClaimKey: "resume-claim-1",
    });
  });

  it("forwards only the canonical local-liveness witness, omitting malformed input", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = async (_url, opts) => {
      bodies.push(JSON.parse(String(opts.body)));
      return {
        ok: true,
        json: async () => ({ ok: true, status: "acquired", acquired: true }),
      };
    };

    await reportSessionResumed(42, {
      fetchImpl,
      operatorUrl: "http://op:1",
      resumeClaimKey: "resume-evidence-1",
      localLivenessEvidence: { kind: "no-live-codex-writer", version: 1 },
    });
    await reportSessionResumed(43, {
      fetchImpl,
      operatorUrl: "http://op:1",
      resumeClaimKey: "resume-evidence-2",
      localLivenessEvidence: {
        version: 1,
        kind: "no-live-codex-writer",
        extra: true,
      },
    });

    expect(bodies).toEqual([
      {
        advSessionId: 42,
        resumeClaimKey: "resume-evidence-1",
        localLivenessEvidence: {
          version: 1,
          kind: "no-live-codex-writer",
        },
      },
      { advSessionId: 43, resumeClaimKey: "resume-evidence-2" },
    ]);
  });

  it("retries an unknown transport result with the SAME replay key", async () => {
    const calls: Array<{ advSessionId: number; resumeClaimKey: string }> = [];
    const fetchImpl: typeof fetch = async (_url, opts) => {
      calls.push(JSON.parse(String(opts?.body)));
      if (calls.length === 1) {
        const error = new Error("response deadline elapsed after commit");
        error.name = "TimeoutError";
        throw error;
      }
      return Response.json({
        ok: true,
        status: "acquired",
        acquired: true,
        replayed: true,
        reactivated: true,
      });
    };

    await expect(
      reportSessionResumed(42, {
        fetchImpl,
        operatorUrl: "http://op:1",
        resumeClaimKey: "resume-claim-replay-1",
        connectBudgetMs: 0,
        timeoutRetries: 1,
        sleep: async () => {},
        onNotice: () => {},
      }),
    ).resolves.toEqual({
      claimed: true,
      status: "acquired",
      resumeClaimKey: "resume-claim-replay-1",
      replayed: true,
    });
    expect(calls).toEqual([
      { advSessionId: 42, resumeClaimKey: "resume-claim-replay-1" },
      { advSessionId: 42, resumeClaimKey: "resume-claim-replay-1" },
    ]);
  });

  it("no adv row id → no request (untracked resumes have no row to re-activate)", async () => {
    const calls = [];
    const fetchImpl = async (...a) => {
      calls.push(a);
      return { ok: true };
    };
    await expect(
      reportSessionResumed(null, {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
      }),
    ).resolves.toEqual({ claimed: false, reason: "no-session" });
    expect(calls).toHaveLength(0);
  });

  it("returns typed reservation refusal metadata instead of inventing a live contender", async () => {
    const falseClaim = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        status: "reserved",
        acquired: false,
        retryAfterMs: 12_000,
        leaseExpiresAt: "2026-08-26T16:00:12.000Z",
        reactivated: false,
      }),
    });
    await expect(
      reportSessionResumed(42, {
        fetchImpl: falseClaim,
        operatorUrl: "http://op:1",
        token: "t",
        resumeClaimKey: "resume-claim-held",
      }),
    ).resolves.toEqual({
      claimed: false,
      reason: "contended",
      status: "reserved",
      resumeClaimKey: "resume-claim-held",
      retryAfterMs: 12_000,
      leaseExpiresAt: "2026-08-26T16:00:12.000Z",
    });
  });

  it("adapts a legacy reactivation success during mixed-version rollout", async () => {
    const notices: string[] = [];
    const legacyClaim = async () => ({
      ok: true,
      json: async () => ({ ok: true, reactivated: true }),
    });
    await expect(
      reportSessionResumed(42, {
        fetchImpl: legacyClaim,
        operatorUrl: "http://op:1",
        token: "t",
        resumeClaimKey: "legacy-resume-1",
        onNotice: (message) => notices.push(message),
      }),
    ).resolves.toEqual({
      claimed: true,
      status: "acquired",
      resumeClaimKey: "legacy-resume-1",
      legacyReactivation: true,
    });
    expect(notices).toEqual([
      expect.stringMatching(/legacy atomic reactivation contract/),
    ]);
  });

  it("keeps a legacy reactivation refusal fail-closed", async () => {
    await expect(
      reportSessionResumed(42, {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ ok: true, reactivated: false }),
        }),
        operatorUrl: "http://op:1",
        token: "t",
        resumeClaimKey: "legacy-resume-lost",
      }),
    ).resolves.toEqual({
      claimed: false,
      reason: "contended",
      status: "live",
      resumeClaimKey: "legacy-resume-lost",
    });
  });

  it("an HTTP failure is reported as HTTP, not as a lost race", async () => {
    const httpFailure = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ ok: true, reactivated: true }),
    });
    const outcome = refusalOf(
      await reportSessionResumed(42, {
        fetchImpl: httpFailure,
        operatorUrl: "http://op:1",
        token: "t",
      }),
    );
    expect(outcome.reason).toBe("http");
    expect(outcome.detail).toContain("503");
  });

  it("an unreadable response body is HTTP (the operator answered badly), not transport", async () => {
    const badBody = async () => ({
      ok: true,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    });
    const outcome = refusalOf(
      await reportSessionResumed(42, {
        fetchImpl: badBody,
        operatorUrl: "http://op:1",
        token: "t",
      }),
    );
    expect(outcome.reason).toBe("http");
  });

  it("a thrown transport error is captured, not swallowed", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const outcome = refusalOf(
      await reportSessionResumed(42, {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
        connectBudgetMs: 0,
        timeoutRetries: 0,
      }),
    );
    expect(outcome.reason).toBe("transport");
    // The swallowed catch was the whole defect: the cause existed and was
    // discarded. What it discarded is better than the raw errno —
    // fetchWithResilience rewrites connect failures into an actionable operator
    // diagnosis (which URL, for how long, how to repair it). Assert that
    // remediation text survives the catch rather than the bare "ECONNREFUSED".
    expect(outcome.detail).toBeTruthy();
    expect(outcome.detail).toMatch(/operator/i);
  });

  it("EVERY refusal path still fails closed — claimed is never true", async () => {
    const refusals = await Promise.all([
      reportSessionResumed(null, { operatorUrl: "http://op:1" }),
      reportSessionResumed(42, {
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          json: async () => ({}),
        }),
        operatorUrl: "http://op:1",
      }),
      reportSessionResumed(42, {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ status: "reserved", acquired: false }),
        }),
        operatorUrl: "http://op:1",
      }),
      reportSessionResumed(42, {
        fetchImpl: async () => {
          throw new Error("boom");
        },
        operatorUrl: "http://op:1",
        connectBudgetMs: 0,
        timeoutRetries: 0,
      }),
    ]);
    expect(refusals.map((r) => r.claimed)).toEqual([false, false, false, false]);
    // ...and each names a DISTINCT cause. This is the regression guard: the bug
    // was four causes wearing one message (EI-21414979137146784).
    expect(refusals.map((r) => refusalOf(r).reason)).toEqual([
      "no-session",
      "http",
      "contended",
      "transport",
    ]);
  });
});

describe("acquireSessionResumeWithRecovery — truthful reserved wait/retry", () => {
  it("preserves explicit relaunch permission across retries and never waits on retirement", async () => {
    const sleep = vi.fn(async () => undefined);
    const reportImpl = vi.fn(async () => ({ claimed: false, reason: "contended", status: "retired", resumeClaimKey: "key" }) as const);
    await expect(acquireSessionResumeWithRecovery(42, { resumeClaimKey: "key", allowRetired: true, reportImpl, sleep })).resolves.toMatchObject({ claimed: false, status: "retired" });
    expect(reportImpl).toHaveBeenCalledExactlyOnceWith(42, { resumeClaimKey: "key", allowRetired: true });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits through a held lease and retries with the SAME attempt key", async () => {
    const keys: string[] = [];
    const sleeps: number[] = [];
    const notices: string[] = [];
    let clock = 0;
    const reportImpl = vi.fn(async (_id, { resumeClaimKey }) => {
      keys.push(resumeClaimKey);
      if (keys.length === 1) {
        return {
          claimed: false,
          reason: "contended",
          status: "reserved",
          retryAfterMs: 1_000,
          leaseExpiresAt: "2026-08-26T16:00:01.000Z",
          resumeClaimKey,
        } as const;
      }
      return {
        claimed: true,
        status: "acquired",
        resumeClaimKey,
        replayed: false,
      } as const;
    });

    await expect(
      acquireSessionResumeWithRecovery(42, {
        resumeClaimKey: "resume-wait-1",
        reportImpl,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        onNotice: (message) => notices.push(message),
      }),
    ).resolves.toEqual({
      claimed: true,
      status: "acquired",
      resumeClaimKey: "resume-wait-1",
      replayed: false,
    });
    expect(keys).toEqual(["resume-wait-1", "resume-wait-1"]);
    expect(sleeps).toEqual([1_050]);
    expect(notices.join("\n")).toContain("waiting 1050ms");
    expect(notices.join("\n")).toContain("same attempt key");
  });

  it("returns the held lease and expiry when it exceeds the bounded auto-wait", async () => {
    const sleep = vi.fn(async () => undefined);
    const reportImpl = vi.fn(
      async (_id, { resumeClaimKey }) =>
        ({
          claimed: false,
          reason: "contended",
          status: "reserved",
          retryAfterMs: 80_000,
          leaseExpiresAt: "2026-08-26T16:01:20.000Z",
          resumeClaimKey,
        }) as const,
    );

    const outcome = await acquireSessionResumeWithRecovery(42, {
      resumeClaimKey: "resume-wait-budget",
      reportImpl,
      now: () => 0,
      sleep,
      onNotice: () => {},
      waitBudgetMs: 75_000,
    });

    expect(outcome).toMatchObject({
      claimed: false,
      status: "reserved",
      leaseExpiresAt: "2026-08-26T16:01:20.000Z",
      resumeClaimKey: "resume-wait-budget",
    });
    expect(refusalOf(outcome).detail).toContain("automatic wait budget");
    expect(sleep).not.toHaveBeenCalled();
    expect(reportImpl).toHaveBeenCalledOnce();
  });

  it("never waits on live, missing, HTTP, or transport outcomes", async () => {
    const sleep = vi.fn(async () => undefined);
    for (const outcome of [
      { claimed: false, reason: "contended", status: "live" } as const,
      { claimed: false, reason: "contended", status: "missing" } as const,
      { claimed: false, reason: "http" } as const,
      { claimed: false, reason: "transport" } as const,
    ]) {
      await expect(
        acquireSessionResumeWithRecovery(42, {
          reportImpl: async () => outcome,
          sleep,
        }),
      ).resolves.toEqual(outcome);
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("forwards one canonical witness across a reserved retry and omits malformed evidence", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const reportImpl = vi.fn(async (_id, opts) => {
      calls.push(opts);
      attempt += 1;
      if (attempt === 1) {
        return {
          claimed: false,
          reason: "contended",
          status: "reserved",
          retryAfterMs: 1,
          resumeClaimKey: opts.resumeClaimKey,
        } as const;
      }
      return {
        claimed: true,
        status: "acquired",
        resumeClaimKey: opts.resumeClaimKey,
      } as const;
    });
    let now = 0;

    await expect(
      acquireSessionResumeWithRecovery(42, {
        resumeClaimKey: "resume-recovery-evidence",
        reportImpl,
        localLivenessEvidence: {
          version: 1,
          kind: "no-live-codex-writer",
        },
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        onNotice: () => {},
      }),
    ).resolves.toMatchObject({ claimed: true, status: "acquired" });
    expect(calls).toEqual([
      {
        resumeClaimKey: "resume-recovery-evidence",
        localLivenessEvidence: {
          version: 1,
          kind: "no-live-codex-writer",
        },
      },
      {
        resumeClaimKey: "resume-recovery-evidence",
        localLivenessEvidence: {
          version: 1,
          kind: "no-live-codex-writer",
        },
      },
    ]);

    const malformedReport = vi.fn(async (_id, opts) => ({
      claimed: true,
      status: "acquired",
      resumeClaimKey: opts.resumeClaimKey,
    } as const));
    await acquireSessionResumeWithRecovery(43, {
      resumeClaimKey: "resume-recovery-omitted",
      reportImpl: malformedReport,
      localLivenessEvidence: {
        version: 1,
        kind: "no-live-codex-writer",
        extra: true,
      },
    });
    expect(malformedReport).toHaveBeenCalledWith(43, {
      resumeClaimKey: "resume-recovery-omitted",
    });
  });
});

describe("resume reservation finalize/release reporters", () => {
  it("sends explicit retirement permission on finalize and omits it on release", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts?.body));
      bodies.push(body);
      return Response.json({ ok: true, finalized: true, released: true, resumeClaimKey: body.resumeClaimKey });
    };
    const options = { fetchImpl, operatorUrl: "http://op:1", allowRetired: true };
    await reportSessionResumeFinalized(42, "key", options);
    await reportSessionResumeReleased(42, "key", options);
    expect(bodies).toEqual([
      { advSessionId: 42, resumeClaimKey: "key", allowRetired: true },
      { advSessionId: 42, resumeClaimKey: "key" },
    ]);
  });

  it("finalizes with the exact acquisition key after spawn evidence", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(String(opts.body));
      calls.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          finalized: true,
          resumeClaimKey: body.resumeClaimKey,
        }),
      };
    };

    await expect(
      reportSessionResumeFinalized(42, "resume-claim-1", {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "tok-1",
        launchArgv: [
          "psu",
          "--no-picker",
          "--resume=42",
          "--agent=claude",
          "--account=auto",
          "--model=opus[1m]:max",
        ],
      }),
    ).resolves.toEqual({ finalized: true, resumeClaimKey: "resume-claim-1" });
    expect(calls).toEqual([
      {
        url: "http://op:1/api/agent-mcp/console/bootstrap-su/session-resume-finalized",
        body: {
          advSessionId: 42,
          resumeClaimKey: "resume-claim-1",
          launchArgv: [
            "psu",
            "--no-picker",
            "--resume=42",
            "--agent=claude",
            "--account=auto",
            "--model=opus[1m]:max",
          ],
        },
      },
    ]);
  });

  it("retries an unknown release result with the SAME key", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts?.body));
      bodies.push(body);
      if (bodies.length === 1) {
        const error = new Error("response deadline elapsed after commit");
        error.name = "TimeoutError";
        throw error;
      }
      return Response.json({
        ok: true,
        released: true,
        resumeClaimKey: body.resumeClaimKey,
      });
    };

    await expect(
      reportSessionResumeReleased(42, "resume-release-replay-1", {
        fetchImpl,
        operatorUrl: "http://op:1",
        connectBudgetMs: 0,
        timeoutRetries: 1,
        sleep: async () => {},
        onNotice: () => {},
      }),
    ).resolves.toEqual({
      released: true,
      resumeClaimKey: "resume-release-replay-1",
    });
    expect(bodies).toEqual([
      { advSessionId: 42, resumeClaimKey: "resume-release-replay-1" },
      { advSessionId: 42, resumeClaimKey: "resume-release-replay-1" },
    ]);
  });

  it("fails closed on missing identity, key, or an untyped acknowledgement", async () => {
    await expect(reportSessionResumeFinalized(null, "key")).resolves.toEqual({
      finalized: false,
      reason: "no-session",
    });
    await expect(reportSessionResumeReleased(42, "")).resolves.toEqual({
      released: false,
      reason: "no-key",
    });
    await expect(
      reportSessionResumeFinalized(42, "key", {
        fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
        operatorUrl: "http://op:1",
      }),
    ).resolves.toMatchObject({ finalized: false, reason: "http" });
  });
});

describe("describeResumeClaimRefusal — four causes must not share one sentence", () => {
  it("never turns a lease/database verdict into an unproven process claim", () => {
    const outcomes = [
      {
        claimed: false,
        reason: "contended",
        status: "reserved",
        leaseExpiresAt: "2026-08-26T16:00:12.000Z",
      } as const,
      { claimed: false, reason: "contended", status: "live" } as const,
      { claimed: false, reason: "contended", status: "missing" } as const,
      { claimed: false, reason: "http" } as const,
      { claimed: false, reason: "transport" } as const,
    ];
    for (const outcome of outcomes) {
      const text = describeResumeClaimRefusal(outcome);
      expect(text).not.toContain("another process holds");
      expect(text).not.toContain("agent process is live");
    }
  });

  it("names held reservation expiry and distinguishes unevaluated requests", () => {
    expect(
      describeResumeClaimRefusal({
        claimed: false,
        reason: "contended",
        status: "reserved",
        leaseExpiresAt: "2026-08-26T16:00:12.000Z",
      }),
    ).toContain("reservation until 2026-08-26T16:00:12.000Z");
    expect(
      describeResumeClaimRefusal({ claimed: false, reason: "http" }),
    ).toContain("did not return an evaluated");
    expect(
      describeResumeClaimRefusal({ claimed: false, reason: "transport" }),
    ).toContain("could not be evaluated");
  });

  it("adds backend-specific recovery context only to the database-live state", () => {
    const live = {
      claimed: false,
      reason: "contended",
      status: "live",
    } as const;
    expect(describeResumeClaimRefusal(live, { agent: "codex" })).toContain(
      "native writer-lock guard",
    );
    // WI-2141892 / WI-2142101: with no probe result supplied, claude and omp both
    // fall back to the did-not-run branch rather than asserting anything about a
    // host nothing observed. The probe-aware branches are covered in the
    // local-liveness blocks below.
    expect(describeResumeClaimRefusal(live, { agent: "claude" })).toContain(
      "did not run",
    );
    expect(describeResumeClaimRefusal(live, { agent: "omp" })).toContain(
      "did not run",
    );

    // The grouping that matters is by ORACLE, not by backend name: codex has its
    // own writer-lock sentence, while claude and omp share the argv-probe branch
    // because they genuinely share the mechanism. They are then distinguished by
    // what the probe REPORTED, which is the honest axis.
    expect(describeResumeClaimRefusal(live, { agent: "codex" })).not.toEqual(
      describeResumeClaimRefusal(live, { agent: "claude" }),
    );
    const probed = (holder: { held: boolean; pid?: number; reason: string }) =>
      new Set(
        (["claude", "omp"] as const).map((agent) =>
          describeResumeClaimRefusal(live, { agent, processHolder: holder }),
        ),
      );
    expect(probed({ held: true, pid: 9, reason: "argv-match" })).not.toEqual(
      probed({ held: false, reason: "no-proc" }),
    );
  });

  it("renders a DISTINCT sentence per reason, and surfaces the detail", () => {
    const sentences = (["no-session", "http", "contended", "transport"] as const).map(
      (reason) => describeResumeClaimRefusal({ claimed: false, reason }),
    );
    expect(new Set(sentences).size).toBe(4);
    expect(
      describeResumeClaimRefusal({
        claimed: false,
        reason: "transport",
        detail: "ECONNREFUSED",
      }),
    ).toContain("ECONNREFUSED");
  });
});

describe("launchResume wiring — claim before setup or spawn", () => {
  const src = readFileSync(
    join(__dirname, "..", "scripts", "psu-launcher.mjs"),
    "utf8",
  );
  const body = src.slice(src.indexOf("async function launchResume("));

  it("reconciles a pending end witness, then acquires before config repair and spawn", () => {
    const pendingEnd = body.indexOf("readPendingSessionEndWitness(session.id)");
    const endReplay = body.indexOf("await reportSessionEnded(", pendingEnd);
    const claim = body.indexOf(
      "const claim = await acquireSessionResumeWithRecovery(session.id,",
    );
    const configRepair = body.indexOf(
      "await ensureInteractiveConfigViaOperator",
    );
    const spawn = body.indexOf("runWrapper({");
    expect(pendingEnd).toBeGreaterThan(-1);
    expect(endReplay).toBeGreaterThan(pendingEnd);
    expect(claim).toBeGreaterThan(endReplay);
    expect(configRepair).toBeGreaterThan(claim);
    expect(spawn).toBeGreaterThan(claim);
  });

  it("reheals default-account Codex auth after home repair and before route/spawn", () => {
    const codexBranch = body.indexOf(
      'if (session.agent === "codex" && env.CODEX_HOME)',
    );
    const homeRepair = body.indexOf("await ensureCodexHomeViaOperator(", codexBranch);
    const hostRepair = src.search(/ensureCodexHome:\s*(?:async\s*)?\([^)]*\)\s*=>/);
    const hostHomeRepair = src.indexOf("ensureCodexHomeViaOperator(", hostRepair);
    const authGuard = body.indexOf(
      'if (accountEnv?.mode === "default")',
      homeRepair,
    );
    const authRepair = body.indexOf(
      "rehealResumeCodexAuth(env.CODEX_HOME);",
      authGuard,
    );
    const route = body.indexOf("applyCodexGatewayRoute(env.CODEX_HOME", authRepair);
    const spawn = body.indexOf("runWrapper({", route);

    expect(codexBranch).toBeGreaterThan(-1);
    expect(homeRepair).toBeGreaterThan(codexBranch);
    // The host callback is in runWrapper; homeRepair is relative to launchResume.
    expect(hostRepair).toBeGreaterThan(-1);
    expect(hostHomeRepair).toBeGreaterThan(hostRepair);
    expect(authGuard).toBeGreaterThan(homeRepair);
    expect(authRepair).toBeGreaterThan(authGuard);
    expect(route).toBeGreaterThan(authRepair);
    expect(spawn).toBeGreaterThan(route);
  });

  it("uses the resolved headless option before resume argv exists (Codex native-fork TDZ regression)", () => {
    const signature = body.slice(0, body.indexOf(") {"));
    const homeRepair = body.slice(
      body.indexOf("await ensureCodexHomeViaOperator("),
      body.indexOf("applyCodexGatewayRoute(env.CODEX_HOME"),
    );
    expect(signature).toContain("headless = false");
    expect(homeRepair).toContain("headless,");
    expect(homeRepair).not.toContain("args.headless");
  });

  it("exits immediately when the ended-session resume claim is lost", () => {
    const claim = body.indexOf(
      "const claim = await acquireSessionResumeWithRecovery(session.id,",
    );
    const refusal = body.indexOf("if (!claim.claimed) {", claim);
    const nextClaimState = body.indexOf("resumeClaimed = true;", refusal);
    const refusalBody = body.slice(refusal, nextClaimState);

    expect(claim).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(claim);
    expect(nextClaimState).toBeGreaterThan(refusal);
    expect(refusalBody).toContain("process.exit(2);");
    expect(refusalBody).not.toContain("process.exitCode = 2;");
  });

  it("computes local evidence before acquisition and forwards it only when canonical", () => {
    const evidence = body.indexOf(
      "localLivenessEvidence = normalizeCodexResumeLocalLivenessEvidence({",
    );
    const claim = body.indexOf(
      "const claim = await acquireSessionResumeWithRecovery(session.id,",
    );
    const forwarded = body.indexOf("...(localLivenessEvidence", claim);

    expect(evidence).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(evidence);
    expect(forwarded).toBeGreaterThan(claim);
  });

  it("releases every post-acquire setup failure with the same key", () => {
    const cleanupHelper = body.indexOf(
      "const cleanupResumeClaim = async () => {",
    );
    const cleanupGuard = body.indexOf(
      "if (!resumeClaimed || session.id == null || !resumeClaimKey) return;",
      cleanupHelper,
    );
    const cleanupReport = body.indexOf(
      "await reportSessionResumeReleased(session.id, resumeClaimKey);",
      cleanupHelper,
    );
    const legacyGuard = body.indexOf(
      "if (resumeClaimLegacyReactivation) {",
      cleanupGuard,
    );
    const legacyCleanup = body.indexOf(
      "const outcome = await reportSessionEnded(session.id, null, {",
      legacyGuard,
    );
    const claimed = body.indexOf("resumeClaimed = true");
    const catchBlock = body.indexOf("} catch (error) {", claimed);
    const cleanupCall = body.indexOf("await cleanupResumeClaim();", catchBlock);
    expect(cleanupHelper).toBeGreaterThan(-1);
    expect(cleanupGuard).toBeGreaterThan(cleanupHelper);
    expect(legacyGuard).toBeGreaterThan(cleanupGuard);
    expect(legacyCleanup).toBeGreaterThan(legacyGuard);
    expect(body.slice(legacyCleanup, cleanupReport)).toContain(
      "launchFailed: true",
    );
    expect(cleanupReport).toBeGreaterThan(cleanupGuard);
    expect(claimed).toBeGreaterThan(-1);
    expect(catchBlock).toBeGreaterThan(cleanupReport);
    expect(cleanupCall).toBeGreaterThan(catchBlock);
  });

  it("finalizes the acquired key only through runWrapper's concrete spawn callback", () => {
    const finalizeHelper = body.indexOf(
      "const finalizeResumeClaim = async () => {",
    );
    const finalizeReport = body.indexOf(
      "await reportSessionResumeFinalized(",
      finalizeHelper,
    );
    const legacyGuard = body.indexOf(
      "if (resumeClaimLegacyReactivation) {",
      finalizeHelper,
    );
    const run = body.indexOf("runWrapper({", finalizeReport);
    const runEnd = body.indexOf("});", run);
    const runBody = body.slice(run, runEnd);

    expect(finalizeHelper).toBeGreaterThan(-1);
    expect(legacyGuard).toBeGreaterThan(finalizeHelper);
    expect(legacyGuard).toBeLessThan(finalizeReport);
    expect(finalizeReport).toBeGreaterThan(finalizeHelper);
    expect(run).toBeGreaterThan(finalizeReport);
    expect(runBody).toContain("onSpawn: finalizeResumeClaim");
    expect(runBody).toContain("onSpawnFailure: cleanupResumeClaim");
  });

  it("returns the async respawn report so the PTY host can enforce ordering", () => {
    // Keep this source-wiring guard independent of the callback's option
    // parameters; the durable retry path may pass an onConfirmed callback.
    const onRespawn = src.indexOf("onRespawn:");
    // WI-10004917: the durable form, so a report lost to an operator restart is retried.
    const report = src.indexOf("return reportSessionRespawnedDurably(", onRespawn);
    const callbackEnd = src.indexOf("        },", report);

    expect(onRespawn).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(onRespawn);
    expect(callbackEnd).toBeGreaterThan(report);
    expect(src.slice(onRespawn, callbackEnd)).not.toMatch(
      /void reportSessionRespawned(Durably)?\(/,
    );
  });

  it("records the acquisition protocol before any post-claim setup", () => {
    const claimed = body.indexOf("resumeClaimed = true;");
    const protocol = body.indexOf(
      "resumeClaimLegacyReactivation = claim.legacyReactivation === true;",
      claimed,
    );
    const setup = body.indexOf("try {", protocol);

    expect(claimed).toBeGreaterThan(-1);
    expect(protocol).toBeGreaterThan(claimed);
    expect(setup).toBeGreaterThan(protocol);
  });
});

describe("reportSessionRespawned (WI-5075: re-anchor adv row native id on carry-respawn/recycle — best-effort, never rejects)", () => {
  const freshId = "1d70c364-c3dd-4dc0-a014-2bbfdd4ccd3f";

  it("POSTs { advSessionId, sessionId } to bootstrap-su/session-respawned with the bearer", async () => {
    const calls: Array<{
      url: string;
      opts: { headers: Record<string, string>; body: string };
    }> = [];
    const fetchImpl = async (url: string, opts: never) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    await reportSessionRespawned("42", freshId, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "tok-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://op:1/api/agent-mcp/console/bootstrap-su/session-respawned",
    );
    expect(calls[0].opts.headers.authorization).toBe("Bearer tok-1");
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      advSessionId: 42,
      sessionId: freshId,
    });
  });

  it("no identity key (neither adv row id nor coordOwnerId) OR no fresh native id → no request", async () => {
    const calls: unknown[] = [];
    const fetchImpl = async (...a: unknown[]) => {
      calls.push(a);
      return { ok: true };
    };
    await reportSessionRespawned(null, freshId, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    await reportSessionRespawned("42", null, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    await reportSessionRespawned(null, null, {
      coordOwnerId: "su-abc",
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    expect(calls).toHaveLength(0);
  });

  it("interactive/`psu --resume` cohort: no adv id but a coordOwnerId → POSTs { coordOwnerId, sessionId }", async () => {
    const calls: Array<{ url: string; opts: { body: string } }> = [];
    const fetchImpl = async (url: string, opts: never) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    await reportSessionRespawned(null, freshId, {
      coordOwnerId: "su-57b6247d-ecdb-4fe1-9734-f91c3b6d0f89",
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      coordOwnerId: "su-57b6247d-ecdb-4fe1-9734-f91c3b6d0f89",
      sessionId: freshId,
    });
  });

  it("adv-spawned cohort: sends BOTH keys so the server can heal a stale adv-id mapping through the owner", async () => {
    const calls: Array<{ url: string; opts: { body: string } }> = [];
    const fetchImpl = async (url: string, opts: never) => {
      calls.push({ url, opts });
      return { ok: true };
    };
    await reportSessionRespawned("42", freshId, {
      coordOwnerId: "su-abc",
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      advSessionId: 42,
      coordOwnerId: "su-abc",
      sessionId: freshId,
    });
  });

  it("swallows transport failures — a respawn must never wait on or fail from the re-anchor", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      reportSessionRespawned(42, freshId, {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
      }),
    ).resolves.toBe(false);
  });

  describe("respawn report diagnostics", () => {
    it.each([200, 503])("persists the real HTTP %i outcome without request or response secrets", async (status) => {
      const dir = mkdtempSync(join(tmpdir(), "respawn-report-events-"));
      const server = createServer((_request, response) => {
        response.writeHead(status);
        response.end("response-body-that-must-not-be-logged");
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("test listener missing");
        await expect(reportSessionRespawned("42", freshId, {
          coordOwnerId: "su-diagnostic-fixture",
          operatorUrl: `http://127.0.0.1:${address.port}`,
          token: "never-log-this-token",
          appendEventImpl: (owner, kind, extra) => appendHostEvent(owner, kind, extra, dir),
        })).resolves.toBe(status === 200);
        const rows = readFileSync(eventLogPathForOwner("su-diagnostic-fixture", dir), "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: "respawn-report-attempt",
          nativeId: freshId,
          endpointClass: "session-respawned",
          outcome: status === 200 ? "accepted" : "http-refused",
          status,
          errorName: null,
          errorCode: null,
          elapsedMs: expect.any(Number),
        });
        expect(rows[0].elapsedMs).toBeGreaterThanOrEqual(0);
        const saved = JSON.stringify(rows);
        expect(saved).not.toContain("never-log-this-token");
        expect(saved).not.toContain("response-body-that-must-not-be-logged");
        expect(saved).not.toContain("http://");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("distinguishes a transport refusal and allowlists error fields", async () => {
      const appendEventImpl = vi.fn();
      const error = Object.assign(new TypeError("secret endpoint and bearer"), {
        cause: { code: "ECONNREFUSED", message: "secret request body" },
      });
      await expect(reportSessionRespawned("42", freshId, {
        coordOwnerId: "su-diagnostic-fixture",
        token: "secret bearer",
        fetchImpl: async () => { throw error; },
        appendEventImpl,
      })).resolves.toBe(false);
      expect(appendEventImpl).toHaveBeenCalledExactlyOnceWith("su-diagnostic-fixture", "respawn-report-attempt", {
        nativeId: freshId,
        endpointClass: "session-respawned",
        outcome: "transport-error",
        status: null,
        errorName: "TypeError",
        errorCode: "ECONNREFUSED",
        elapsedMs: expect.any(Number),
      });
      expect(JSON.stringify(appendEventImpl.mock.calls)).not.toContain("secret");
    });

    it("records an actual deadline abort as a timeout", async () => {
      const appendEventImpl = vi.fn();
      await expect(reportSessionRespawned("42", freshId, {
        coordOwnerId: "su-diagnostic-fixture",
        token: "fixture",
        timeoutMs: 10,
        fetchImpl: async (_url, options) => {
          const signal = options?.signal;
          if (!signal) throw new Error("test request signal missing");
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        appendEventImpl,
      })).resolves.toBe(false);
      expect(appendEventImpl).toHaveBeenCalledExactlyOnceWith("su-diagnostic-fixture", "respawn-report-attempt", {
        nativeId: freshId,
        endpointClass: "session-respawned",
        outcome: "timeout",
        status: null,
        errorName: "TimeoutError",
        errorCode: null,
        elapsedMs: expect.any(Number),
      });
    });

    it("omits arbitrary error names and codes", async () => {
      const appendEventImpl = vi.fn();
      await reportSessionRespawned("42", freshId, {
        coordOwnerId: "su-diagnostic-fixture",
        token: "fixture",
        fetchImpl: async () => { throw { name: "secret name", code: "secret code", message: "secret message" }; },
        appendEventImpl,
      });
      expect(appendEventImpl.mock.calls[0]?.[2]).toMatchObject({
        outcome: "transport-error", errorName: "Error", errorCode: null,
      });
      expect(JSON.stringify(appendEventImpl.mock.calls)).not.toContain("secret");
    });

    it.each([true, false])("a failed diagnostic write preserves the report verdict %s", async (ok) => {
      const appendEventImpl = vi.fn(() => { throw new Error("event store unavailable"); });
      await expect(reportSessionRespawned("42", freshId, {
        coordOwnerId: "su-diagnostic-fixture",
        token: "fixture",
        fetchImpl: async () => new Response("", { status: ok ? 200 : 503 }),
        appendEventImpl,
      })).resolves.toBe(ok);
      expect(appendEventImpl).toHaveBeenCalledTimes(1);
    });
  });
});

describe("reportSessionRespawnedDurably (WI-10004917: a respawn report lost to an operator restart is retried)", () => {
  const freshId = "1d70c364-c3dd-4dc0-a014-2bbfdd4ccd3f";
  const newerId = "2e81d475-d4ee-4ed1-b125-3cceee5dde4e";

  /** A sleep the test releases by hand, one pending delay at a time. */
  function manualSleep() {
    const pending: Array<{ ms: number; release: () => void }> = [];
    const sleepImpl = (ms: number) =>
      new Promise<void>((resolve) => pending.push({ ms, release: resolve }));
    const tick = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return { pending, sleepImpl, tick };
  }

  it("resolves with the first attempt's verdict and retries in the background until accepted", async () => {
    const verdicts = [false, false, true];
    const reportImpl = vi.fn(async () => verdicts.shift() ?? true);
    const { pending, sleepImpl, tick } = manualSleep();
    await expect(
      reportSessionRespawnedDurably("42", freshId, {
        coordOwnerId: "su-owner",
        reportImpl,
        retryDelaysMs: [5, 15, 30],
        sleepImpl,
      }),
    ).resolves.toBe(false);
    expect(reportImpl).toHaveBeenCalledTimes(1);
    expect(reportImpl).toHaveBeenCalledWith("42", freshId, { coordOwnerId: "su-owner" });

    await tick();
    expect(pending.map((p) => p.ms)).toEqual([5]);
    pending.shift()!.release();
    await tick();
    expect(reportImpl).toHaveBeenCalledTimes(2);
    pending.shift()!.release();
    await tick();
    expect(reportImpl).toHaveBeenCalledTimes(3);
    // Accepted: no further delay is scheduled.
    expect(pending).toHaveLength(0);
  });

  it("does not retry an accepted first report", async () => {
    const reportImpl = vi.fn(async () => true);
    const { pending, sleepImpl, tick } = manualSleep();
    await expect(
      reportSessionRespawnedDurably("42", freshId, { reportImpl, sleepImpl }),
    ).resolves.toBe(true);
    await tick();
    expect(reportImpl).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(0);
  });

  it("notifies the carry after an eventual reanchor confirmation exactly once", async () => {
    const onConfirmed = vi.fn();
    const reportImpl = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { pending, sleepImpl, tick } = manualSleep();
    await expect(reportSessionRespawnedDurably("42", freshId, {
      reportImpl, retryDelaysMs: [5, 15], sleepImpl, onConfirmed,
    })).resolves.toBe(false);
    expect(onConfirmed).not.toHaveBeenCalled();
    await tick();
    pending.shift()!.release();
    await tick();
    expect(reportImpl).toHaveBeenCalledTimes(2);
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith(freshId);
    expect(pending).toHaveLength(0);
  });

  it("withholds eventual confirmation from a superseded in-flight report", async () => {
    let acceptOlder!: (accepted: boolean) => void;
    const olderConfirmed = vi.fn();
    const newerConfirmed = vi.fn();
    const reportImpl = vi.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      acceptOlder = resolve;
    })).mockResolvedValue(true);
    const older = reportSessionRespawnedDurably("42", freshId, {
      reportImpl, retryDelaysMs: [], onConfirmed: olderConfirmed,
    });
    await Promise.resolve();
    await expect(reportSessionRespawnedDurably("42", newerId, {
      reportImpl, onConfirmed: newerConfirmed,
    })).resolves.toBe(true);
    acceptOlder(true);
    await expect(older).resolves.toBe(false);
    expect(olderConfirmed).not.toHaveBeenCalled();
    expect(newerConfirmed).toHaveBeenCalledExactlyOnceWith(newerId);
  });

  it("a newer respawn supersedes an older retry, so a late retry never re-anchors the older id", async () => {
    const reportImpl = vi.fn(async () => false);
    const { pending, sleepImpl, tick } = manualSleep();
    await reportSessionRespawnedDurably("42", freshId, { reportImpl, retryDelaysMs: [5, 15], sleepImpl });
    await tick();
    await reportSessionRespawnedDurably("42", newerId, { reportImpl, retryDelaysMs: [5, 15], sleepImpl });
    await tick();
    expect(pending).toHaveLength(2);
    for (const p of pending.splice(0)) p.release();
    await tick();
    const reported = reportImpl.mock.calls.map((call) => (call as unknown[])[1]);
    expect(reported).toEqual([freshId, newerId, newerId]);
  });

  it("gives up after the last delay and never rejects", async () => {
    const reportImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { pending, sleepImpl, tick } = manualSleep();
    await expect(
      reportSessionRespawnedDurably(null, freshId, {
        coordOwnerId: "su-owner",
        reportImpl,
        retryDelaysMs: [5, 15],
        sleepImpl,
      }),
    ).resolves.toBe(false);
    for (let i = 0; i < 2; i++) {
      await tick();
      pending.shift()!.release();
    }
    await tick();
    expect(reportImpl).toHaveBeenCalledTimes(3);
    expect(pending).toHaveLength(0);
  });

  it("no identity key or no native id: no attempt and no retry", async () => {
    const reportImpl = vi.fn(async () => true);
    const { pending, sleepImpl, tick } = manualSleep();
    await expect(reportSessionRespawnedDurably(null, freshId, { reportImpl, sleepImpl })).resolves.toBe(false);
    await expect(reportSessionRespawnedDurably("42", null, { reportImpl, sleepImpl })).resolves.toBe(false);
    await tick();
    expect(reportImpl).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
  });

  it("every launcher re-anchor call site uses the durable form", () => {
    const src = readFileSync(fileURLToPath(new URL("../scripts/psu-launcher.mjs", import.meta.url)), "utf8");
    const announce = src.indexOf("export async function announceAdoptedCarryRespawn(");
    expect(src.slice(announce, announce + 400)).toContain("reportImpl = reportSessionRespawnedDurably,");
    const callers = [...src.matchAll(/(?:void|return) (reportSessionRespawned\w*)\(/g)].map((m) => m[1]);
    // Positive control: the scan found the call sites at all.
    expect(callers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(callers)).toEqual(new Set(["reportSessionRespawnedDurably"]));
  });
});

describe("adoptedCarryRespawnFromHandoff (WI-10004791 late Codex id)", () => {
  it("preserves a null Codex native id for pty-host proof and ignores non-carry handoffs", () => {
    expect(adoptedCarryRespawnFromHandoff({ mode: "carry-respawn", nativeId: null }))
      .toEqual({ nativeId: null });
    expect(adoptedCarryRespawnFromHandoff({ mode: "carry-respawn", nativeId: "native-123" }))
      .toEqual({ nativeId: "native-123" });
    expect(adoptedCarryRespawnFromHandoff({ mode: "recycle", nativeId: "native-123" })).toBeNull();
  });

  it("preserves drill correlation metadata across host-code adoption", () => {
    expect(adoptedCarryRespawnFromHandoff({
      mode: "carry-respawn",
      nativeId: "native-123",
      drillId: "drill-456",
      sessionClass: "claude-su",
      launchContextPath: "/tmp/carry context.md",
    })).toEqual({
      nativeId: "native-123",
      drillId: "drill-456",
      sessionClass: "claude-su",
      launchContextPath: "/tmp/carry context.md",
    });
  });

  it("routes adoption through pty-host first-turn proof before launcher-side re-anchor", () => {
    const src = readFileSync(fileURLToPath(new URL("../scripts/psu-launcher.mjs", import.meta.url)), "utf8");
    const handoffStart = src.indexOf("const hostHandoff =");
    const handoffEnd = src.indexOf("adopted updated host code for", handoffStart);
    const handoff = src.slice(handoffStart, handoffEnd);
    expect(handoff).toContain("adoptedCarryRespawn = adoptedCarryRespawnFromHandoff(hostHandoff);");
    expect(handoff).not.toContain("announceAdoptedCarryRespawn(");
    const hostCallStart = src.indexOf("hostThroughPty({", handoffEnd);
    const hostCallEnd = src.indexOf("}).catch((e)", hostCallStart);
    expect(src.slice(hostCallStart, hostCallEnd)).toContain("adoptedCarryRespawn,");
  });
});

describe("announceAdoptedCarryRespawn (EI-21567375926533125 — report before wake)", () => {
  const freshId = "1d70c364-c3dd-4dc0-a014-2bbfdd4ccd3f";

  it("announces an eventual reanchor confirmation after the first report fails", async () => {
    let confirm!: (nativeId: string) => void;
    const emitImpl = vi.fn();
    await expect(announceAdoptedCarryRespawn("su-owner", "42", freshId, {
      reportImpl: vi.fn(async (_adv, _native, options) => {
        confirm = options.onConfirmed;
        return false;
      }),
      emitImpl,
    })).resolves.toBe(false);
    expect(emitImpl).not.toHaveBeenCalled();
    expect(confirm).toBeTypeOf("function");
    confirm(freshId);
    confirm(freshId);
    expect(emitImpl).toHaveBeenCalledExactlyOnceWith("su-owner", "carry-respawn", { nativeId: freshId });
  });

  it("waits for a successful successor re-anchor before emitting session:compacted", async () => {
    const order: string[] = [];
    let resolveReport!: (accepted: boolean) => void;
    const reportImpl = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveReport = (accepted) => {
            order.push("report");
            resolve(accepted);
          };
        }),
    );
    const emitImpl = vi.fn(() => order.push("emit"));
    const announced = announceAdoptedCarryRespawn("su-owner", "42", freshId, {
      reportImpl,
      emitImpl,
    });

    await Promise.resolve();
    expect(reportImpl).toHaveBeenCalledWith("42", freshId, {
      coordOwnerId: "su-owner", onConfirmed: expect.any(Function),
    });
    expect(emitImpl).not.toHaveBeenCalled();

    resolveReport(true);
    await expect(announced).resolves.toBe(true);
    expect(order).toEqual(["report", "emit"]);
    expect(emitImpl).toHaveBeenCalledWith("su-owner", "carry-respawn", { nativeId: freshId });
  });

  it("does not emit a wake when the operator did not accept the re-anchor", async () => {
    const emitImpl = vi.fn();
    await expect(
      announceAdoptedCarryRespawn("su-owner", "42", freshId, {
        reportImpl: vi.fn(async () => false),
        emitImpl,
      }),
    ).resolves.toBe(false);
    expect(emitImpl).not.toHaveBeenCalled();
  });
});

// EI-9756 regression guard: "archive a session, then resume it, and assert the
// conversation actually continues" — the report's own requested GUARD. The
// deeper archive/rematerialize byte-fidelity is covered by
// session-archive.test.ts; this pins the CLI-side glue (previously wired but
// completely untested) that psu --resume depends on to recover a session
// whose transcript the archive-at-death lifecycle deletes ~15s after every
// session end (WI-3859 F4) — NOT just a stale/swept one.
describe("tryRematerializeFromArchive (psu --resume self-heals a transcript the archive-at-death hook deleted)", () => {
  it.each([false, true])("uses the verified archive root for a tracked Claude source (timeout recovery: %s)", async (afterTimeout) => {
    const root = mkdtempSync(join(tmpdir(), "psu-restored-root-"));
    const sid = "0123abcd-1234-5678-9abc-def012345678";
    const archiveRoot = join(root, "archive-owner");
    const projects = join(archiveRoot, "projects", "project");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${sid}.jsonl`), JSON.stringify({ sessionId: sid }) + "\n");
    const source = { id: 29708, agent: "claude", sessionId: sid, coordOwnerId: "su-tracked-owner", configDir: join(root, "tracked-owner") };
    const restored = { ok: true, ready: true, sourceKind: "claude", written: 1, root: archiveRoot };
    const fetchImpl = async (_url, opts) => {
      if (afterTimeout && opts.method === "POST") {
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return { json: async () => restored };
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(sessionHasTranscript(source, { home: root })).toBe(false);
      await tryRematerializeFromArchive(sid, "claude", { fetchImpl, operatorUrl: "http://op:1", token: "tok", sourceSession: source, home: root });
      expect(sessionHasTranscript(source, { home: root })).toBe(true);
      expect(source).toEqual({ id: 29708, agent: "claude", sessionId: sid, coordOwnerId: "su-tracked-owner", configDir: archiveRoot });
    } finally {
      errSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("does not adopt an archive root without the tracked source's exact Claude transcript (shared copy: %s)", async (sharedCopy) => {
    const root = mkdtempSync(join(tmpdir(), "psu-restored-miss-"));
    const source = { agent: "claude", sessionId: "exact-native-id", coordOwnerId: "su-source", configDir: join(root, "original") };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const projects = join(root, "archive", "projects", "project");
      mkdirSync(projects, { recursive: true });
      writeFileSync(join(projects, "other-native-id.jsonl"), "{}\n");
      if (sharedCopy) {
        const shared = join(root, ".claude", "projects", "project");
        mkdirSync(shared, { recursive: true });
        writeFileSync(join(shared, `${source.sessionId}.jsonl`), "{}\n");
      }
      await tryRematerializeFromArchive(source.sessionId, "claude", {
        fetchImpl: async () => ({ json: async () => ({ ok: true, sourceKind: "claude", written: 1, root: join(root, "archive") }) }),
        operatorUrl: "http://op:1", token: "tok", sourceSession: source, home: root,
      });
      expect(source.configDir).toBe(join(root, "original"));
      expect(sessionHasTranscript(source, { home: root })).toBe(sharedCopy);
    } finally {
      errSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for an in-flight archive restore after the POST times out", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    let statusReads = 0;
    const fetchImpl = async (_url, opts) => {
      if (opts.method === "POST") throw timeout;
      statusReads += 1;
      return {
        json: async () => statusReads <= 3
          ? { ok: true, state: "pending", pending: true, ready: false }
          : { ok: true, state: "ready", pending: false, ready: true, sourceKind: "claude", written: 1, root: "/tmp/restored" },
      };
    };
    const sleep = vi.fn(async () => {});

    try {
      await expect(
        tryRematerializeFromArchive("sid-pending", "claude", {
          fetchImpl,
          operatorUrl: "http://op:1",
          token: "tok",
          statusDelayMs: 1,
          sleep,
        }),
      ).resolves.toMatchObject({
        ok: true,
        sourceKind: "claude",
        written: 1,
        root: "/tmp/restored",
        restoredAfterTimeout: true,
      });
      expect(statusReads).toBe(4);
      expect(sleep).toHaveBeenCalledTimes(3);
    } finally {
      errSpy.mockRestore();
    }
  });

  it.each(["not_ready", "not_archived"])("does not report an in-flight restore when status is %s", async (state) => {
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    const fetchImpl = vi.fn(async (_url, opts) => {
      if (opts.method === "POST") throw timeout;
      return { json: async () => ({ ok: true, state, pending: false, ready: false }) };
    });
    const sleep = vi.fn(async () => {});

    const result = await tryRematerializeFromArchive("sid-missing", "codex", {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "tok",
      sleep,
    });
    if (state === "not_archived") expect(result).toBeNull();
    else expect(result).toMatchObject({ ok: false, failed: true, reason: "restore_not_ready" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps the resume pending when the bounded status checks never observe completion", async () => {
    const timeout = new Error("request timed out");
    timeout.name = "TimeoutError";
    const fetchImpl = async (_url, opts) => {
      if (opts.method === "POST") throw timeout;
      return { json: async () => ({ ok: true, state: "pending", pending: true, ready: false }) };
    };

    await expect(
      tryRematerializeFromArchive("sid-still-pending", "claude", {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "tok",
        statusAttempts: 2,
        statusDelayMs: 1,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ ok: false, pending: true, timedOut: true, reason: "in_flight" });
  });

  it("POSTs sessionId (+ sourceKind when given) and returns the parsed result on ok:true", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return {
        json: async () => ({
          ok: true,
          sourceKind: "claude",
          written: 1,
          root: "/tmp/restored",
        }),
      };
    };
    const r = await tryRematerializeFromArchive("sid-1", "claude", {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "tok-1",
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://op:1/api/adv/sessions/rematerialize");
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.headers.authorization).toBe("Bearer tok-1");
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      sessionId: "sid-1",
      sourceKind: "claude",
    });
    expect(r).toEqual({
      ok: true,
      sourceKind: "claude",
      written: 1,
      root: "/tmp/restored",
    });
  });

  it("omits sourceKind when not given (probes all three archive kinds)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(opts);
      return { json: async () => ({ ok: true, written: 0 }) };
    };
    await tryRematerializeFromArchive("sid-2", null, {
      fetchImpl,
      operatorUrl: "http://op:1",
      token: "t",
    });
    expect(JSON.parse(calls[0].body)).toEqual({ sessionId: "sid-2" });
    errSpy.mockRestore();
  });

  it("no sessionId → no request, returns null", async () => {
    const calls = [];
    const fetchImpl = async (...a) => {
      calls.push(a);
      return { json: async () => ({ ok: true }) };
    };
    expect(
      await tryRematerializeFromArchive(null, "claude", {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("an explicit not_archived result returns null", async () => {
    const fetchImpl = async () => ({
      json: async () => ({ ok: false, reason: "not_archived" }),
    });
    expect(
      await tryRematerializeFromArchive("sid-3", null, {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
      }),
    ).toBeNull();
  });

  it("preserves an unreachable operator as a request failure", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      tryRematerializeFromArchive("sid-4", null, {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
      }),
    ).resolves.toMatchObject({ ok: false, failed: true, reason: "request_failed", error: expect.stringContaining("ECONNREFUSED") });
  });

  it("preserves a malformed response instead of claiming archive absence", async () => {
    const fetchImpl = async () => ({
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    expect(
      await tryRematerializeFromArchive("sid-5", null, {
        fetchImpl,
        operatorUrl: "http://op:1",
        token: "t",
      }),
    ).toMatchObject({ ok: false, failed: true, reason: "invalid_response" });
  });
});

describe("fetchWithResilience (psu connection-retry hardening)", () => {
  // A fake clock advanced by the injected sleep makes retry timing deterministic
  // without real timers or sockets.
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }
  const connFail = () => {
    throw new TypeError("fetch failed");
  };
  const timeoutErr = () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    throw e;
  };
  // Pin the target so these tests never inherit the RUNNER box's real
  // operator.json via the module-level OPERATOR_TARGET default (WI-3271).
  const devTarget = {
    url: "http://op",
    source: "dev-default",
    startedAt: null,
  };

  it("formats a final proxy overload with detail and retry guidance", () => {
    expect(
      formatApiFailureMessage(
        {
          error: "mcp_proxy_overloaded",
          detail:
            "proxy already has 192 request(s) in flight — shed before forwarding",
          retryAfterSec: 2,
        },
        429,
        "/api/adv/sessions/resumable",
      ),
    ).toBe(
      "GET /api/adv/sessions/resumable (HTTP 429) — mcp_proxy_overloaded — proxy already has 192 request(s) in flight — shed before forwarding — retry in 2s",
    );
  });

  it("EI-25231240145060739: distinguishes bootstrap hops with the same route deadline", () => {
    const failure = { error: { code: "timeout", message: "route exceeded 30s" } };
    const picker = formatApiFailureMessage(failure, 408, "/api/agent-mcp/console/bootstrap-su/options");
    const bootstrap = formatApiFailureMessage(failure, 408, "/api/agent-mcp/console/bootstrap-su", "post");
    expect(picker).toBe("GET /api/agent-mcp/console/bootstrap-su/options (HTTP 408) — timeout — route exceeded 30s");
    expect(bootstrap).toBe("POST /api/agent-mcp/console/bootstrap-su (HTTP 408) — timeout — route exceeded 30s");
    expect(picker).not.toBe(bootstrap);
  });

  it("omits query credentials and fragments from the failed request diagnostic", () => {
    const message = formatApiFailureMessage(
      { error: { code: "timeout", message: "route exceeded 30s" } },
      408,
      "/api/agent-mcp/console/bootstrap-su?token=private-query-token#private-fragment",
      "POST",
    );
    expect(message).toContain("POST /api/agent-mcp/console/bootstrap-su (HTTP 408)");
    expect(message).not.toContain("private-query-token");
    expect(message).not.toContain("private-fragment");
  });

  it("recognizes only a Retry-After-marked 429 as proxy overload", () => {
    expect(
      isRetryableMcpProxyOverload({
        status: 429,
        headers: new Headers({ "retry-after": "2" }),
      }),
    ).toBe(true);
    expect(
      isRetryableMcpProxyOverload({ status: 429, headers: new Headers() }),
    ).toBe(false);
    expect(
      isRetryableMcpProxyOverload({
        status: 503,
        headers: new Headers({ "retry-after": "2" }),
      }),
    ).toBe(false);
    expect(proxyOverloadRetryDelayMs("2")).toBe(2_000);
    expect(proxyOverloadRetryDelayMs("99")).toBe(5_000);
    expect(proxyOverloadRetryDelayMs("garbage")).toBe(1_000);
  });

  it("recovers thirty concurrent key-bearing bootstraps after one typed upstream-silent 502 each", async () => {
    const attempts = Array.from({ length: 30 }, () => 0);
    const results = await Promise.all(
      attempts.map(async (_unused, index) => {
        const body = JSON.stringify({
          bootstrap_idempotency_key: `key-${index}`,
        });
        return fetchWithResilience(
          "http://op/api/agent-mcp/console/bootstrap-su",
          { method: "POST", body },
          {
            fetchImpl: async (_url, init) => {
              expect(init?.body).toBe(body); // the SAME key crosses every replay
              attempts[index] += 1;
              return new Response(
                JSON.stringify(
                  attempts[index] === 1
                    ? {
                        error: "mcp_proxy_upstream_error",
                        detail:
                          "upstream silent for 8000ms (no response headers)",
                      }
                    : { status: "ok", sessionId: index + 1 },
                ),
                {
                  status: attempts[index] === 1 ? 502 : 200,
                  headers: { "content-type": "application/json" },
                },
              );
            },
            sleep: async () => {},
            now: () => 0,
            onNotice: () => {},
            target: devTarget,
            retryBootstrapFailures: true,
          },
        );
      }),
    );

    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(attempts).toEqual(Array.from({ length: 30 }, () => 2));
    expect(BOOTSTRAP_REPLAY_MAX_ATTEMPTS).toBe(4);
    expect(BOOTSTRAP_REPLAY_BUDGET_MS).toBe(30_000);
  });

  it("WI-6554700010018056: opens the bootstrap replay window at the first failure, not at request start", async () => {
    const upstreamSilent = () =>
      new Response(
        JSON.stringify({ error: "mcp_proxy_upstream_error", detail: "read ECONNRESET" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    // A long bootstrap reset after 45s (past the 30s budget measured from start)
    // still gets its same-key replay.
    const lateClock = fakeClock();
    let lateAttempts = 0;
    const late = await fetchWithResilience(
      "http://op/api/agent-mcp/console/bootstrap-role",
      { method: "POST", body: JSON.stringify({ bootstrap_idempotency_key: "late" }) },
      {
        fetchImpl: async () => {
          lateAttempts += 1;
          if (lateAttempts === 1) {
            await lateClock.sleep(45_000);
            return upstreamSilent();
          }
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        sleep: lateClock.sleep,
        now: lateClock.now,
        onNotice: () => {},
        target: devTarget,
        retryBootstrapFailures: true,
      },
    );
    expect(late.status).toBe(200);
    expect(lateAttempts).toBe(2);

    // A sustained outage stays bounded: once the window that opened at the first
    // failure has elapsed, the typed 502 is surfaced instead of replayed again.
    const slowClock = fakeClock();
    let slowAttempts = 0;
    const exhausted = await fetchWithResilience(
      "http://op/api/agent-mcp/console/bootstrap-role",
      { method: "POST", body: JSON.stringify({ bootstrap_idempotency_key: "slow" }) },
      {
        fetchImpl: async () => {
          slowAttempts += 1;
          await slowClock.sleep(45_000);
          return upstreamSilent();
        },
        sleep: slowClock.sleep,
        now: slowClock.now,
        onNotice: () => {},
        target: devTarget,
        retryBootstrapFailures: true,
      },
    );
    expect(exhausted.status).toBe(502);
    expect(slowAttempts).toBe(2);
  });

  it("retries a typed in-progress bootstrap but never an arbitrary 502", async () => {
    let inProgressAttempts = 0;
    const recovered = await fetchWithResilience(
      "http://op/api/agent-mcp/console/bootstrap-su",
      {},
      {
        fetchImpl: async () => {
          inProgressAttempts += 1;
          return new Response(
            JSON.stringify(
              inProgressAttempts === 1
                ? { error: "bootstrap_in_progress", retryAfterSec: 0 }
                : { status: "ok" },
            ),
            {
              status: inProgressAttempts === 1 ? 409 : 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
        sleep: async () => {},
        now: () => 0,
        onNotice: () => {},
        target: devTarget,
        retryBootstrapFailures: true,
      },
    );
    expect(recovered.status).toBe(200);
    expect(inProgressAttempts).toBe(2);

    let genericAttempts = 0;
    const generic = await fetchWithResilience(
      "http://op/api/agent-mcp/console/bootstrap-su",
      {},
      {
        fetchImpl: async () => {
          genericAttempts += 1;
          return new Response(JSON.stringify({ error: "bad_gateway" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        },
        sleep: async () => {},
        now: () => 0,
        onNotice: () => {},
        target: devTarget,
        retryBootstrapFailures: true,
      },
    );
    expect(generic.status).toBe(502);
    expect(genericAttempts).toBe(1);
  });

  it("retries a proxy overload on Retry-After and returns once admission recovers", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      if (n < 3) {
        return {
          status: 429,
          headers: new Headers({ "retry-after": "2" }),
          body: null,
        } as unknown as Response;
      }
      return { status: 200, ok: true } as unknown as Response;
    };
    const res = await fetchWithResilience(
      "http://op/api/adv/sessions/resumable",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: () => {},
        target: devTarget,
      },
    );
    expect(res.status).toBe(200);
    expect(n).toBe(3);
    expect(clock.now()).toBe(4_000);
  });

  it("bounds repeated proxy overloads by five total attempts and twenty seconds", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      return {
        status: 429,
        headers: new Headers({ "retry-after": "20" }),
        body: null,
      } as unknown as Response;
    };
    const res = await fetchWithResilience(
      "http://op/api/adv/sessions/resumable",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: () => {},
        target: devTarget,
      },
    );
    expect(res.status).toBe(429);
    expect(n).toBe(MCP_PROXY_OVERLOAD_MAX_ATTEMPTS);
    expect(clock.now()).toBeLessThanOrEqual(MCP_PROXY_OVERLOAD_RETRY_BUDGET_MS);
  });

  it("rides through a recycle: retries a connection failure on a backoff and returns once the host is back", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      if (n < 3) connFail();
      return { ok: true, id: "live" } as unknown as Response;
    };
    const res = await fetchWithResilience(
      "http://op/x",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: () => {},
        connectBudgetMs: 30_000,
        target: devTarget,
      },
    );
    expect((res as unknown as { id: string }).id).toBe("live");
    expect(n).toBe(3); // two dead-window failures ridden through, third succeeds
  });

  it('exhausts the connect budget then throws "could not reach … after Ns"', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      connFail();
      return undefined as unknown as Response;
    };
    await expect(
      fetchWithResilience(
        "http://op/x",
        {},
        {
          fetchImpl,
          now: clock.now,
          sleep: clock.sleep,
          onNotice: () => {},
          connectBudgetMs: 5_000,
          target: devTarget,
        },
      ),
    ).rejects.toThrow(/could not reach the operator .* after \d+s/);
    expect(n).toBeGreaterThan(1); // it retried within the budget, not a single shot
  });

  it("announces the connection retry exactly once, not per attempt", async () => {
    const clock = fakeClock();
    const notices: string[] = [];
    const fetchImpl = async () => {
      connFail();
      return undefined as unknown as Response;
    };
    await fetchWithResilience(
      "http://op/x",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: (m) => notices.push(m),
        connectBudgetMs: 6_000,
        target: devTarget,
      },
    ).catch(() => {});
    expect(
      notices.filter((m) => /unreachable .* retrying for up to/.test(m)),
    ).toHaveLength(1);
  });

  it('caps timeout retries (reachable-but-slow) and throws "did not respond within"', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      timeoutErr();
      return undefined as unknown as Response;
    };
    await expect(
      fetchWithResilience(
        "http://op/x",
        {},
        {
          fetchImpl,
          now: clock.now,
          sleep: clock.sleep,
          onNotice: () => {},
          timeoutRetries: 1,
          target: devTarget,
        },
      ),
    ).rejects.toThrow(/did not respond within \d+ms/);
    expect(n).toBe(2); // initial attempt + 1 capped retry, then give up
  });

  it("a caller-supplied AbortSignal disables retry (caller owns the lifetime)", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      connFail();
      return undefined as unknown as Response;
    };
    const ac = new AbortController();
    await expect(
      fetchWithResilience(
        "http://op/x",
        { signal: ac.signal },
        {
          fetchImpl,
          now: clock.now,
          sleep: clock.sleep,
          onNotice: () => {},
          connectBudgetMs: 30_000,
          target: devTarget,
        },
      ),
    ).rejects.toThrow(/could not reach/);
    expect(n).toBe(1); // single attempt — no retry when the caller owns the signal
  });

  // ── WI-3271: dead-desktop fail-fast (the owner's "psu → nothing happened") ──

  it('STALE desktop discovery + refused → fails FAST (~5s, not the 30s budget) with "start the Papercusp app" guidance', async () => {
    const clock = fakeClock();
    // startedAt an hour before the fake clock's origin → record is stale.
    const staleTarget = {
      url: "http://127.0.0.1:21487",
      source: "discovery",
      startedAt: -3_600_000,
    };
    const fetchImpl = async () => {
      connFail();
      return undefined as unknown as Response;
    };
    await expect(
      fetchWithResilience(
        "http://127.0.0.1:21487/x",
        {},
        {
          fetchImpl,
          now: clock.now,
          sleep: clock.sleep,
          onNotice: () => {},
          connectBudgetMs: 30_000,
          target: staleTarget,
        },
      ),
    ).rejects.toThrow(
      /Papercusp app's server isn't running .*Start \(or restart\) the Papercusp desktop app/,
    );
    expect(clock.now()).toBeLessThanOrEqual(6_000); // fast fail — never burned the 30s ride-through
  });

  it("FRESH desktop discovery + refused → keeps the full ride-through (operator plausibly mid-boot), desktop-flavored final error", async () => {
    const clock = fakeClock();
    const freshTarget = {
      url: "http://127.0.0.1:21487",
      source: "discovery",
      startedAt: -60_000,
    }; // 1 min old
    const fetchImpl = async () => {
      connFail();
      return undefined as unknown as Response;
    };
    await expect(
      fetchWithResilience(
        "http://127.0.0.1:21487/x",
        {},
        {
          fetchImpl,
          now: clock.now,
          sleep: clock.sleep,
          onNotice: () => {},
          connectBudgetMs: 30_000,
          target: freshTarget,
        },
      ),
    ).rejects.toThrow(/Start \(or restart\) the Papercusp desktop app/);
    expect(clock.now()).toBeGreaterThanOrEqual(30_000); // full budget honored for a mid-restart window
  });

  it("desktop discovery TIMEOUT advice says restart-the-app, never dev-box systemctl", async () => {
    const clock = fakeClock();
    const target = {
      url: "http://127.0.0.1:21487",
      source: "discovery",
      startedAt: -60_000,
    };
    const fetchImpl = async () => {
      timeoutErr();
      return undefined as unknown as Response;
    };
    const err = await fetchWithResilience(
      "http://127.0.0.1:21487/x",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: () => {},
        timeoutRetries: 0,
        target,
      },
    ).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/restart the Papercusp desktop app/);
    expect(err?.message).not.toMatch(/systemctl/);
  });

  it("server timeout guidance uses coordinated recovery without guessing a service", async () => {
    const clock = fakeClock();
    const err = await fetchWithResilience(
      "http://127.0.0.1:3170/x",
      {},
      {
        fetchImpl: async () => {
          timeoutErr();
          return undefined as unknown as Response;
        },
        now: clock.now,
        sleep: clock.sleep,
        onNotice: () => {},
        timeoutRetries: 0,
        target: { url: "http://127.0.0.1:3170", source: "env" },
      },
    ).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("http://127.0.0.1:3170");
    expect(err?.message).toContain("dev:restart");
    expect(err?.message).not.toMatch(/systemctl|papercup-dev-api|papercusp-dev-api/);
  });

  it("stale-desktop announce notice names the app and the short check window, once", async () => {
    const clock = fakeClock();
    const staleTarget = {
      url: "http://127.0.0.1:21487",
      source: "discovery",
      startedAt: -3_600_000,
    };
    const notices: string[] = [];
    const fetchImpl = async () => {
      connFail();
      return undefined as unknown as Response;
    };
    await fetchWithResilience(
      "http://127.0.0.1:21487/x",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: (m) => notices.push(m),
        connectBudgetMs: 30_000,
        target: staleTarget,
      },
    ).catch(() => {});
    expect(
      notices.filter((m) =>
        /Papercusp app's server .* isn't answering .* checking for 5s/.test(m),
      ),
    ).toHaveLength(1);
  });

  // ── stale-shell heal (mac VM owner repro 2026-07-07): a dead managed
  //    target fails over to a health-checked live operator instead of burning
  //    the whole budget on a port the terminal window outlived. ──

  const envTarget = {
    url: "http://127.0.0.1:59999",
    source: "managed-env",
    startedAt: null,
  };

  it.each([undefined, "unknown"])("keeps an explicit env pin fixed on connection refusal (provenance %s)", async (provenance) => {
    const clock = fakeClock();
    const target = resolveOperatorTarget({
      env: {
        PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3170",
        ...(provenance ? { PAPERCUSP_OPERATOR_URL_PROVENANCE: provenance } : {}),
      },
      probe: () => false,
    });
    const resolveFallback = vi.fn(() => [
      { url: "http://127.0.0.1:9071", source: "proxy", startedAt: null },
    ]);
    const onFailover = vi.fn();
    const seen: string[] = [];
    await expect(fetchWithResilience(`${target.url}/x`, {}, {
      target,
      fetchImpl: async (url: string) => {
        seen.push(url);
        if (url.startsWith(target.url)) connFail();
        return { ok: true } as Response;
      },
      now: clock.now,
      sleep: clock.sleep,
      onNotice: () => {},
      connectBudgetMs: 5_000,
      resolveFallback,
      onFailover,
    })).rejects.toThrow(/PAPERCUSP_OPERATOR_URL.*refused connections/s);
    expect(seen.length).toBeGreaterThan(1); // retries stay on the chosen build
    expect(new Set(seen)).toEqual(new Set([`${target.url}/x`]));
    expect(resolveFallback).not.toHaveBeenCalled();
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("dead managed env + healthy discovery fallback → switches, adopts, and succeeds on the live operator", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const fetchImpl = async (u: string) => {
      seen.push(u);
      if (u.startsWith("http://127.0.0.1:59999")) connFail();
      return { ok: true, id: "live" } as unknown as Response;
    };
    const notices: string[] = [];
    const adopted: Array<{ url: string }> = [];
    const res = await fetchWithResilience(
      "http://127.0.0.1:59999/x",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: (m) => notices.push(m),
        connectBudgetMs: 30_000,
        target: envTarget,
        resolveFallback: () => [
          {
            url: "http://127.0.0.1:21960",
            source: "discovery",
            startedAt: null,
          },
        ],
        onFailover: (t: { url: string }) => adopted.push(t),
      },
    );
    expect((res as unknown as { id: string }).id).toBe("live");
    expect(seen).toContain("http://127.0.0.1:21960/api/health"); // health-gated, not a blind switch
    expect(seen).toContain("http://127.0.0.1:21960/x"); // request rebased onto the live origin
    expect(adopted.map((t) => t.url)).toEqual(["http://127.0.0.1:21960"]); // adopted session-wide
    expect(
      notices.some(
        (m) => /switching/.test(m) && /PAPERCUSP_OPERATOR_URL/.test(m),
      ),
    ).toBe(true);
  });

  it("an UNHEALTHY fallback candidate is skipped — no switch, original budget-exhausted failure", async () => {
    const clock = fakeClock();
    const adopted: string[] = [];
    const fetchImpl = async (u: string) => {
      if (u.endsWith("/api/health"))
        return { ok: false } as unknown as Response; // candidate up but unhealthy
      connFail();
      return undefined as unknown as Response;
    };
    await expect(
      fetchWithResilience(
        "http://127.0.0.1:59999/x",
        {},
        {
          fetchImpl,
          now: clock.now,
          sleep: clock.sleep,
          onNotice: () => {},
          connectBudgetMs: 5_000,
          target: envTarget,
          resolveFallback: () => [
            {
              url: "http://127.0.0.1:21960",
              source: "discovery",
              startedAt: null,
            },
          ],
          onFailover: (t: { url: string }) => adopted.push(t.url),
        },
      ),
    ).rejects.toThrow(/could not reach the operator/s);
    expect(adopted).toEqual([]); // never adopted an unhealthy target
  });

  it("failover is attempted exactly ONCE per call, and never for a caller-custom URL outside the target base", async () => {
    const clock = fakeClock();
    let resolves = 0;
    const fetchImpl = async () => {
      connFail();
      return undefined as unknown as Response;
    };
    await fetchWithResilience(
      "http://127.0.0.1:59999/x",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: () => {},
        connectBudgetMs: 10_000,
        target: envTarget,
        resolveFallback: () => {
          resolves += 1;
          return [];
        },
      },
    ).catch(() => {});
    expect(resolves).toBe(1);

    resolves = 0;
    await fetchWithResilience(
      "http://other-host:1234/x",
      {},
      {
        fetchImpl,
        now: clock.now,
        sleep: clock.sleep,
        onNotice: () => {},
        connectBudgetMs: 5_000,
        target: envTarget,
        resolveFallback: () => {
          resolves += 1;
          return [];
        },
      },
    ).catch(() => {});
    expect(resolves).toBe(0); // custom URL not under target.url — never rebased
  });
});

describe("resolveFallbackOperatorTargets (stale-shell heal candidate ladder)", () => {
  it("lists proxy then discovery (from operator.json) then dev default, excluding the dead URL", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-fallback-"));
    try {
      mkdirSync(join(home, ".papercusp"), { recursive: true });
      writeFileSync(
        join(home, ".papercusp", "operator.json"),
        JSON.stringify({
          httpUrl: "http://127.0.0.1:21960",
          startedAt: Date.now(),
        }),
      );
      const out = resolveFallbackOperatorTargets({
        env: {},
        home,
        excludeUrls: ["http://127.0.0.1:59999"],
      });
      expect(out.map((c) => c.source)).toEqual([
        "proxy",
        "discovery",
        "dev-default",
      ]);
      expect(out[1]!.url).toBe("http://127.0.0.1:21960");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("respects PAPERCUSP_MCP_PROXY=0 (no proxy candidate) and a missing operator.json", () => {
    const home = mkdtempSync(join(tmpdir(), "psu-fallback-"));
    try {
      const out = resolveFallbackOperatorTargets({
        env: { PAPERCUSP_MCP_PROXY: "0" },
        home,
      });
      expect(out.map((c) => c.source)).toEqual(["dev-default"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("applyLauncherOperatorUrlEnv (wake-respawn URL provenance)", () => {
  it.each([
    { PAPERCUSP_HONO_PORT: "3880" },
    { PAPERCUSP_OPERATOR_BASE: "http://127.0.0.1:3880" },
    {
      PAPERCUSP_HONO_PORT: "3880",
      PAPERCUSP_OPERATOR_BASE: "http://127.0.0.1:3880",
    },
  ])("removes inherited host routing hints before agent ptool calls: %j", (hints) => {
    const env = { ...hints } as Record<string, string>;
    expect(resolvePtoolOperatorBase({
      ...env,
      PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:9071",
    })).toBe("http://127.0.0.1:3880");
    applyLauncherOperatorUrlEnv(env, {
      url: "http://127.0.0.1:9071", source: "proxy", startedAt: null,
    });
    expect(env.PAPERCUSP_HONO_PORT).toBeUndefined();
    expect(env.PAPERCUSP_OPERATOR_BASE).toBeUndefined();
    expect(resolvePtoolOperatorBase(env)).toBe("http://127.0.0.1:9071");
  });

  it("preserves managed provenance through child launch and target resolution", () => {
    const env: Record<string, string> = {};
    applyLauncherOperatorUrlEnv(env, {
      url: "http://127.0.0.1:24689", source: "discovery", startedAt: null,
    });
    const inherited = resolveOperatorTarget({ env, probe: () => false });
    expect(inherited.source).toBe("managed-env");
    applyLauncherOperatorUrlEnv(env, inherited);
    expect(env.PAPERCUSP_OPERATOR_URL_PROVENANCE).toBe("psu-launcher");
    expect(resolveOperatorTarget({ env, probe: () => false })).toEqual(inherited);
  });

  it("marks discovered targets as launcher-managed", () => {
    const env: Record<string, string> = {};
    applyLauncherOperatorUrlEnv(env, {
      url: "http://127.0.0.1:24689",
      source: "discovery",
      startedAt: null,
    });
    expect(env).toEqual({
      PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:24689",
      PAPERCUSP_OPERATOR_URL_PROVENANCE: "psu-launcher",
    });
  });

  it("clears a stale marker when the target is an explicit env pin", () => {
    const env: Record<string, string> = {
      PAPERCUSP_OPERATOR_URL_PROVENANCE: "psu-launcher",
    };
    applyLauncherOperatorUrlEnv(env, {
      url: "http://127.0.0.1:24689",
      source: "env",
      startedAt: null,
    });
    expect(env).toEqual({
      PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:24689",
    });
  });
});

describe("operator endpoint resolution (desktop vs dev box)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-op-"));
    mkdirSync(join(home, ".papercusp"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const writeOperatorJson = (obj: unknown) =>
    writeFileSync(
      join(home, ".papercusp", "operator.json"),
      JSON.stringify(obj),
    );

  describe("resolveOperatorUrl", () => {
    const noProxy = () => false;

    it("falls back to the dev-box :3070 when no operator.json and no proxy (the dev box)", () => {
      expect(resolveOperatorUrl({ env: {}, home, probe: noProxy })).toBe(
        "http://localhost:3070",
      );
    });

    it("reads the desktop operator httpUrl from operator.json (the shipping bug fix)", () => {
      writeOperatorJson({
        httpUrl: "http://127.0.0.1:24689",
        port: "24689",
        token: "abc",
      });
      expect(resolveOperatorUrl({ env: {}, home, probe: noProxy })).toBe(
        "http://127.0.0.1:24689",
      );
    });

    it("synthesizes a URL from port when httpUrl is absent", () => {
      writeOperatorJson({ port: "31337", token: "abc" });
      expect(resolveOperatorUrl({ env: {}, home, probe: noProxy })).toBe(
        "http://127.0.0.1:31337",
      );
    });

    it("PAPERCUSP_OPERATOR_URL env overrides operator.json (explicit wins)", () => {
      writeOperatorJson({ httpUrl: "http://127.0.0.1:24689" });
      expect(
        resolveOperatorUrl({
          env: { PAPERCUSP_OPERATOR_URL: "http://override:9999" },
          home,
          probe: noProxy,
        }),
      ).toBe("http://override:9999");
    });

    it("falls back to :3070 on a malformed operator.json", () => {
      writeFileSync(join(home, ".papercusp", "operator.json"), "{ not json");
      expect(resolveOperatorUrl({ env: {}, home, probe: noProxy })).toBe(
        "http://localhost:3070",
      );
    });

    // ── WI-3271: resolveOperatorTarget carries the SOURCE + record age so the
    // connection-failure path can tell a dead desktop from a dev box ──

    it('resolveOperatorTarget: operator.json → source "discovery" with its startedAt', () => {
      writeOperatorJson({
        httpUrl: "http://127.0.0.1:24689",
        port: 24689,
        startedAt: 1783377109561,
      });
      expect(resolveOperatorTarget({ env: {}, home, probe: noProxy })).toEqual({
        url: "http://127.0.0.1:24689",
        source: "discovery",
        startedAt: 1783377109561,
      });
    });

    it("resolveOperatorTarget: missing/invalid startedAt stays null (age unknown → no fast-fail)", () => {
      writeOperatorJson({ httpUrl: "http://127.0.0.1:24689" });
      expect(
        resolveOperatorTarget({ env: {}, home, probe: noProxy }).startedAt,
      ).toBeNull();
    });

    it('resolveOperatorTarget: env override → source "env"; bare dev box → "dev-default"', () => {
      expect(
        resolveOperatorTarget({
          env: { PAPERCUSP_OPERATOR_URL: "http://override:9999" },
          home,
          probe: noProxy,
        }),
      ).toEqual({
        url: "http://override:9999",
        source: "env",
        startedAt: null,
      });
      expect(resolveOperatorTarget({ env: {}, home, probe: noProxy })).toEqual({
        url: "http://localhost:3070",
        source: "dev-default",
        startedAt: null,
      });
    });

    // ── WI-1457: the resilient MCP proxy preference (re-cutover hardening) ──

    it("prefers the ACTIVE resilient proxy over direct :3070 on the dev box", () => {
      const probed: number[] = [];
      const url = resolveOperatorUrl({
        env: {},
        home,
        probe: (port: number) => {
          probed.push(port);
          return true;
        },
      });
      expect(url).toBe("http://127.0.0.1:9071");
      expect(probed).toEqual([9071]);
    });

    it("PAPERCUSP_MCP_PROXY=0 opts out without even probing", () => {
      let probes = 0;
      const url = resolveOperatorUrl({
        env: { PAPERCUSP_MCP_PROXY: "0" },
        home,
        probe: () => {
          probes++;
          return true;
        },
      });
      expect(url).toBe("http://localhost:3070");
      expect(probes).toBe(0);
    });

    it("keeps launches from the staging operator on its same-vintage proxy", () => {
      const probed: number[] = [];
      const warnings: string[] = [];
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_HONO_PORT: "3170",
          PAPERCUSP_MCP_STAGING_PROXY_PORT: "9171",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return port === 9171;
        },
        warn: (message: string) => warnings.push(message),
      });

      expect(target).toEqual({
        url: "http://127.0.0.1:9171",
        source: "proxy",
        startedAt: null,
      });
      expect(probed).toEqual([9171]);
      expect(warnings[0]).toMatch(/same-vintage MCP proxy :9171/);
    });

    it("routes a managed legacy :9071 URL to staging when the bound host is :3170", () => {
      const probed: number[] = [];
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:9071",
          PAPERCUSP_OPERATOR_URL_PROVENANCE: "psu-launcher",
          PAPERCUSP_HONO_PORT: "3170",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return port === 9171;
        },
        warn: () => {},
      });

      expect(target).toEqual({
        url: "http://127.0.0.1:9171",
        source: "managed-env",
        startedAt: null,
      });
      expect(probed).toEqual([9171]);
    });

    it("uses the resolved local staging base when the Hono port hint is absent", () => {
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_OPERATOR_BASE: "http://127.0.0.1:3170/api/mcp",
          PAPERCUSP_MCP_STAGING_PROXY_PORT: "9272",
        },
        home,
        probe: (port: number) => port === 9272,
        warn: () => {},
      });

      expect(target).toEqual({
        url: "http://127.0.0.1:9272",
        source: "proxy",
        startedAt: null,
      });
    });

    it("stays on staging directly when its same-vintage proxy is unavailable", () => {
      const probed: number[] = [];
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_HONO_PORT: "3170",
          PAPERCUSP_MCP_STAGING_PROXY_PORT: "9171",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return false;
        },
        warn: () => {},
      });

      expect(target).toEqual({
        url: "http://127.0.0.1:3170",
        source: "staging-host",
        startedAt: null,
      });
      expect(probed).toEqual([9171]);
    });

    it.each([
      { PAPERCUSP_MCP_PROXY: "0" },
      { PAPERCUSP_MCP_STAGING_PROXY: "0" },
    ])("honors staging proxy opt-outs and keeps the current host: %j", (overrides) => {
      let probes = 0;
      const target = resolveOperatorTarget({
        env: { PAPERCUSP_HONO_PORT: "3170", ...overrides },
        home,
        probe: () => {
          probes++;
          return true;
        },
        warn: () => {},
      });

      expect(target).toEqual({
        url: "http://127.0.0.1:3170",
        source: "staging-host",
        startedAt: null,
      });
      expect(probes).toBe(0);
    });

    it("honors PAPERCUSP_MCP_PROXY_PORT for both the probe and the url", () => {
      const probed: number[] = [];
      const url = resolveOperatorUrl({
        env: { PAPERCUSP_MCP_PROXY_PORT: "9171" },
        home,
        probe: (port: number) => {
          probed.push(port);
          return true;
        },
      });
      expect(url).toBe("http://127.0.0.1:9171");
      expect(probed).toEqual([9171]);
    });

    it("WI-3247: active proxy wins over desktop operator.json so child env stays stable across dynamic port restarts", () => {
      writeOperatorJson({ httpUrl: "http://127.0.0.1:24689" });
      expect(resolveOperatorUrl({ env: {}, home, probe: () => true })).toBe(
        "http://127.0.0.1:9071",
      );
      expect(
        resolveOperatorTarget({ env: {}, home, probe: () => true }),
      ).toEqual({
        url: "http://127.0.0.1:9071",
        source: "proxy",
        startedAt: null,
      });
    });

    it("warns (active-but-unrouted) when an explicit :3070 pin bypasses a live proxy — override still wins", () => {
      const warnings: string[] = [];
      const url = resolveOperatorUrl({
        env: { PAPERCUSP_OPERATOR_URL: "http://localhost:3070" },
        home,
        probe: () => true,
        warn: (m: string) => warnings.push(m),
      });
      expect(url).toBe("http://localhost:3070"); // explicit override is honored
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/WI-1457/);
      expect(warnings[0]).toMatch(/:9071/);
    });

    it("does NOT warn on a :3070 pin when the proxy is down (nothing to route through)", () => {
      const warnings: string[] = [];
      resolveOperatorUrl({
        env: { PAPERCUSP_OPERATOR_URL: "http://localhost:3070" },
        home,
        probe: noProxy,
        warn: (m: string) => warnings.push(m),
      });
      expect(warnings).toHaveLength(0);
    });

    // ── EI-24402391758483336: a :3170 (staging) pin rides the staging proxy ──
    // A direct :3170 pin is refused for every staging restart window, so psu
    // failed with "refused connections for 30s" / "route exceeded 30s". When the
    // staging proxy (:9171 → :3170) is live the pin must route through it — the
    // same operator build, but restarts are held open instead of refused.

    it("routes an explicit :3170 pin through a LIVE staging proxy (children inherit it)", () => {
      const probed: number[] = [];
      const warnings: string[] = [];
      const target = resolveOperatorTarget({
        env: { PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3170" },
        home,
        probe: (port: number) => {
          probed.push(port);
          return port === 9171;
        },
        warn: (m: string) => warnings.push(m),
      });
      expect(target).toEqual({
        url: "http://127.0.0.1:9171",
        source: "env",
        startedAt: null,
      });
      expect(probed).toContain(9171);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/EI-24402391758483336/);
      expect(warnings[0]).toMatch(/PAPERCUSP_MCP_STAGING_PROXY=0/);
    });

    it("routes a localhost:3170 pin (and a suffixed /api/mcp one) through the staging proxy too", () => {
      for (const pin of [
        "http://localhost:3170",
        "http://127.0.0.1:3170/api/mcp",
      ]) {
        expect(
          resolveOperatorUrl({
            env: { PAPERCUSP_OPERATOR_URL: pin },
            home,
            probe: (port: number) => port === 9171,
            warn: () => {},
          }),
        ).toBe("http://127.0.0.1:9171");
      }
    });

    it("keeps the managed-env provenance when a launcher-managed :3170 pin is proxied", () => {
      expect(
        resolveOperatorTarget({
          env: {
            PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3170",
            PAPERCUSP_OPERATOR_URL_PROVENANCE: "psu-launcher",
          },
          home,
          probe: (port: number) => port === 9171,
          warn: () => {},
        }),
      ).toEqual({
        url: "http://127.0.0.1:9171",
        source: "managed-env",
        startedAt: null,
      });
    });

    it("repairs a legacy launcher-managed :9071 route when staging supplies :9171", () => {
      const probed: number[] = [];
      const warnings: string[] = [];
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:9071",
          PAPERCUSP_OPERATOR_URL_PROVENANCE: "psu-launcher",
          PAPERCUSP_MCP_STAGING_PROXY_PORT: "9171",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return port === 9171;
        },
        warn: (message: string) => warnings.push(message),
      });

      expect(target).toEqual({
        url: "http://127.0.0.1:9171",
        source: "managed-env",
        startedAt: null,
      });
      expect(probed).toEqual([9171]);
      expect(warnings[0]).toMatch(/legacy green route for staging/);
    });

    it("does not reinterpret a managed :9071 route when its proxy target is explicit", () => {
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:9071",
          PAPERCUSP_OPERATOR_URL_PROVENANCE: "psu-launcher",
          PAPERCUSP_MCP_STAGING_PROXY_PORT: "9171",
          PAPERCUSP_MCP_PROXY_TARGET_PORT: "3070",
        },
        home,
        probe: () => true,
        warn: () => {},
      });

      expect(target).toEqual({
        url: "http://127.0.0.1:9071",
        source: "managed-env",
        startedAt: null,
      });
    });

    it("connects to :3170 directly when the staging proxy is DOWN (no silent redirect to green)", () => {
      const warnings: string[] = [];
      const target = resolveOperatorTarget({
        env: { PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3170" },
        home,
        // the green proxy (:9071) is alive — it must NOT be substituted for staging
        probe: (port: number) => port === 9071,
        warn: (m: string) => warnings.push(m),
      });
      expect(target.url).toBe("http://127.0.0.1:3170");
      expect(warnings).toHaveLength(0);
    });

    it("PAPERCUSP_MCP_STAGING_PROXY=0 opts out without probing the staging proxy", () => {
      const probed: number[] = [];
      const url = resolveOperatorUrl({
        env: {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3170",
          PAPERCUSP_MCP_STAGING_PROXY: "0",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return true;
        },
        warn: () => {},
      });
      expect(url).toBe("http://127.0.0.1:3170");
      expect(probed).not.toContain(9171);
    });

    it("honors PAPERCUSP_MCP_STAGING_PROXY_PORT for both the probe and the url", () => {
      const probed: number[] = [];
      const url = resolveOperatorUrl({
        env: {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3170",
          PAPERCUSP_MCP_STAGING_PROXY_PORT: "9272",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return port === 9272;
        },
        warn: () => {},
      });
      expect(url).toBe("http://127.0.0.1:9272");
      expect(probed).toContain(9272);
      expect(probed).not.toContain(9171);
    });

    // EI-24899559853673371: background-host sessions use the dedicated
    // :9271 → :3271 same-vintage proxy, carried as base + upstream port.
    it("routes a local :3271 pin through its active same-vintage background proxy", () => {
      const probed: number[] = [];
      const warnings: string[] = [];
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3271",
          PAPERCUSP_OPERATOR_URL_PROVENANCE: "psu-launcher",
          PAPERCUSP_MCP_PROXY_BASE: "http://127.0.0.1:9271/",
          PAPERCUSP_MCP_PROXY_TARGET_PORT: "3271",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return port === 9271;
        },
        warn: (message: string) => warnings.push(message),
      });
      expect(target).toEqual({
        url: "http://127.0.0.1:9271",
        source: "managed-env",
        startedAt: null,
      });
      expect(probed).toEqual([9271]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/EI-24899559853673371/);
      expect(warnings[0]).toMatch(/PAPERCUSP_MCP_PROXY=0/);
    });

    it("keeps :3271 direct when its proxy is down, even if the live :9071 proxy is up", () => {
      const probed: number[] = [];
      const warnings: string[] = [];
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3271",
          PAPERCUSP_MCP_PROXY_BASE: "http://127.0.0.1:9271",
          PAPERCUSP_MCP_PROXY_TARGET_PORT: "3271",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return port === 9071;
        },
        warn: (message: string) => warnings.push(message),
      });
      expect(target.url).toBe("http://127.0.0.1:3271");
      expect(probed).toEqual([9271]);
      expect(warnings).toHaveLength(0);
    });

    it("does not route a :3271 pin through a proxy for another runtime or a remote host", () => {
      const warnings: string[] = [];
      for (const env of [
        {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3271",
          PAPERCUSP_MCP_PROXY_BASE: "http://127.0.0.1:9071",
          PAPERCUSP_MCP_PROXY_TARGET_PORT: "3070",
        },
        {
          PAPERCUSP_OPERATOR_URL: "http://10.0.0.5:3271",
          PAPERCUSP_MCP_PROXY_BASE: "http://127.0.0.1:9271",
          PAPERCUSP_MCP_PROXY_TARGET_PORT: "3271",
        },
      ]) {
        expect(
          resolveOperatorUrl({
            env,
            home,
            probe: () => true,
            warn: (message: string) => warnings.push(message),
          }),
        ).toBe(env.PAPERCUSP_OPERATOR_URL);
      }
      expect(warnings).toHaveLength(0);
    });

    it("PAPERCUSP_MCP_PROXY=0 opts out of same-vintage background proxy routing", () => {
      const probed: number[] = [];
      const target = resolveOperatorTarget({
        env: {
          PAPERCUSP_OPERATOR_URL: "http://127.0.0.1:3271",
          PAPERCUSP_MCP_PROXY: "0",
          PAPERCUSP_MCP_PROXY_BASE: "http://127.0.0.1:9271",
          PAPERCUSP_MCP_PROXY_TARGET_PORT: "3271",
        },
        home,
        probe: (port: number) => {
          probed.push(port);
          return true;
        },
        warn: () => {},
      });
      expect(target.url).toBe("http://127.0.0.1:3271");
      expect(probed).toEqual([]);
    });

    it("leaves non-staging pins untouched even with the staging proxy live", () => {
      for (const pin of [
        "http://127.0.0.1:3070",
        "http://127.0.0.1:24689",
        "http://10.0.0.5:3170", // a remote host's :3170 is not our staging proxy's upstream
      ]) {
        expect(
          resolveOperatorUrl({
            env: { PAPERCUSP_OPERATOR_URL: pin },
            home,
            probe: (port: number) => port === 9171,
            warn: () => {},
          }),
        ).toBe(pin);
      }
    });
  });

  describe("readToken", () => {
    it("prefers the superuser-token file", () => {
      writeFileSync(
        join(home, ".papercusp", "superuser-token"),
        "tok-from-file\n",
      );
      writeOperatorJson({ token: "tok-from-operator-json" });
      expect(readToken({ home })).toBe("tok-from-file");
    });

    it("uses PAPERCUSP_HOME's token instead of the host user's token", () => {
      const scopedHome = join(home, ".papercusp-workspaces", "demo", ".papercusp");
      mkdirSync(scopedHome, { recursive: true });
      writeFileSync(join(home, ".papercusp", "superuser-token"), "tok-from-host\n");
      writeFileSync(join(scopedHome, "superuser-token"), "tok-from-scoped\n");

      const priorHome = process.env.HOME;
      const priorPapercuspHome = process.env.PAPERCUSP_HOME;
      try {
        process.env.HOME = home;
        process.env.PAPERCUSP_HOME = scopedHome;
        expect(readToken()).toBe("tok-from-scoped");
      } finally {
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
        if (priorPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
        else process.env.PAPERCUSP_HOME = priorPapercuspHome;
      }
    });

    it("does not fall back to the host user's token when the scoped token is missing", () => {
      const scopedHome = join(home, ".papercusp-workspaces", "empty", ".papercusp");
      mkdirSync(join(home, ".papercusp"), { recursive: true });
      mkdirSync(scopedHome, { recursive: true });
      writeFileSync(join(home, ".papercusp", "superuser-token"), "tok-from-host\n");

      const priorHome = process.env.HOME;
      const priorPapercuspHome = process.env.PAPERCUSP_HOME;
      try {
        process.env.HOME = home;
        process.env.PAPERCUSP_HOME = scopedHome;
        expect(readToken()).toBe("");
      } finally {
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
        if (priorPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
        else process.env.PAPERCUSP_HOME = priorPapercuspHome;
      }
    });

    it("falls back to operator.json.token when superuser-token is absent (fresh desktop)", () => {
      writeOperatorJson({
        httpUrl: "http://127.0.0.1:24689",
        token: "tok-from-operator-json",
      });
      expect(readToken({ home })).toBe("tok-from-operator-json");
    });

    it("returns empty string when neither source exists (dev-box open operator)", () => {
      expect(readToken({ home })).toBe("");
    });
  });
});

describe("default-account Claude OAuth token inheritance (psu-login-inherit / macOS keychain trap)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-claude-oauth-"));
    mkdirSync(join(home, ".papercusp"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const TOKEN = "sk-ant-oat01-EXAMPLE-token-value";

  describe("store / read round-trip", () => {
    it("reads null when no token is stored", () => {
      expect(readStoredClaudeOAuthToken({ home })).toBeNull();
    });

    it("persists the token 0600 and reads it back trimmed", () => {
      const p = storeClaudeOAuthToken(`  ${TOKEN}\n`, { home });
      expect(p).toBe(claudeOAuthTokenPath({ home }));
      expect(readStoredClaudeOAuthToken({ home })).toBe(TOKEN);
      // 0600 — owner-only (the file holds a long-lived credential).
      expect(statSync(p).mode & 0o777).toBe(0o600);
    });

    it("refuses to store an empty token", () => {
      expect(() => storeClaudeOAuthToken("   ", { home })).toThrow(/empty/i);
    });
  });

  describe("applyDefaultClaudeOAuthToken — when it injects", () => {
    it("injects CLAUDE_CODE_OAUTH_TOKEN for a default-account claude launch", () => {
      storeClaudeOAuthToken(TOKEN, { home });
      const env: Record<string, string> = {};
      applyDefaultClaudeOAuthToken("claude-su", env, { home });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    });

    it("injects on a RAW claude resume (bin `claude`) and an absolute path", () => {
      storeClaudeOAuthToken(TOKEN, { home });
      for (const bin of [
        "claude",
        "/Users/x/.papercusp/bin/claude",
        "/usr/lib/p/bin/claude-su",
      ]) {
        const env: Record<string, string> = {};
        applyDefaultClaudeOAuthToken(bin, env, { home });
        expect(env.CLAUDE_CODE_OAUTH_TOKEN, bin).toBe(TOKEN);
      }
    });

    it("an explicit default route discards every inherited Claude credential, then injects the system login (WI-5052 acceptance)", () => {
      storeClaudeOAuthToken(TOKEN, { home });
      const env: Record<string, string> = {
        ...defaultAccountEnv(),
        ...Object.fromEntries(
          CLAUDE_DEFAULT_AUTH_ENV_KEYS.map((key) => [key, `old-${key}`]),
        ),
        PAPERCUSP_ACCOUNT_ID: "old-pin",
        CLAUDE_CODE_OAUTH_TOKEN: "old-oauth",
        PAPERCUSP_ANTHROPIC_URL: "http://127.0.0.1:8788",
        PAPERCUSP_CODEX_GATEWAY: "1",
      };
      enforceDefaultClaudeAccount("claude", env);
      expect(env).toEqual({ [ACCOUNT_ROUTING_MODE_ENV]: "default" });
      applyDefaultClaudeOAuthToken("claude", env, { home });
      expect(env).toEqual({
        [ACCOUNT_ROUTING_MODE_ENV]: "default",
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      });
    });

    it("without an explicit default route, direct user credentials remain untouched", () => {
      const env: Record<string, string> = {
        ANTHROPIC_API_KEY: "direct-user-key",
      };
      enforceDefaultClaudeAccount("claude", env);
      expect(env).toEqual({ ANTHROPIC_API_KEY: "direct-user-key" });
    });

    it("adds a highest-precedence settings override for every explicit Claude route", () => {
      const args = ["--resume", "session-id"];
      const applied = applyDefaultClaudeAuthSettingsArgs(
        "claude",
        args,
        defaultAccountEnv(),
      );
      expect(applied.slice(0, 2)).toEqual([
        "--settings",
        JSON.stringify(defaultClaudeAuthSettings()),
      ]);
      expect(applied.slice(2)).toEqual(args);
      expect(JSON.parse(applied[1]!)).toEqual(defaultClaudeAuthSettings());
      expect(defaultClaudeAuthSettings().apiKeyHelper).toBe("");
      expect(Object.keys(defaultClaudeAuthSettings().env)).toEqual([
        ...CLAUDE_DEFAULT_AUTH_ENV_KEYS,
      ]);
      expect(
        Object.values(defaultClaudeAuthSettings().env).every(
          (value) => value === "",
        ),
      ).toBe(true);
      expect(CLAUDE_DEFAULT_AUTH_ENV_KEYS).toEqual(
        expect.arrayContaining([
          "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
          "CLAUDE_CODE_API_BASE_URL",
          "ANTHROPIC_UNIX_SOCKET",
          "ANTHROPIC_BEDROCK_BASE_URL",
          "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
          "ANTHROPIC_VERTEX_BASE_URL",
        ]),
      );
      // Empty OAuth in settings suppresses file/Keychain fallback, so it must
      // never be part of the secret-free override.
      expect(
        defaultClaudeAuthSettings().env.CLAUDE_CODE_OAUTH_TOKEN,
      ).toBeUndefined();

      expect(applyDefaultClaudeAuthSettingsArgs("claude", args, {})).toBe(args);
      expect(
        applyDefaultClaudeAuthSettingsArgs("omp", args, defaultAccountEnv()),
      ).toBe(args);

      const auto = gatewayAutoEnv("claude", "su-auto");
      const autoApplied = applyDefaultClaudeAuthSettingsArgs(
        "claude",
        args,
        auto,
      );
      const autoSettings = JSON.parse(autoApplied[1]!);
      expect(autoSettings.env.ANTHROPIC_BASE_URL).toBe(auto.ANTHROPIC_BASE_URL);
      expect(autoSettings.env.ANTHROPIC_AUTH_TOKEN).toBe(
        GATEWAY_CLIENT_AUTH_TOKEN,
      );
      expect(autoSettings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        `${OWNER_HEADER}: su-auto`,
      );
      expect(autoSettings.env.CLAUDE_CODE_USE_BEDROCK).toBe("");
    });
  });

  describe("applyDefaultClaudeOAuthToken — when it stays a no-op (env byte-identical)", () => {
    it("does nothing when no token is stored (keychain/file login as before)", () => {
      const env: Record<string, string> = {};
      applyDefaultClaudeOAuthToken("claude-su", env, { home });
      expect(env).toEqual({});
    });

    it("skips non-claude backends (codex/omp authenticate by their own file creds)", () => {
      storeClaudeOAuthToken(TOKEN, { home });
      for (const bin of [
        "codex-su",
        "codex",
        "omp-su",
        "omp",
        "/path/to/codex",
      ]) {
        const env: Record<string, string> = {};
        applyDefaultClaudeOAuthToken(bin, env, { home });
        expect(env.CLAUDE_CODE_OAUTH_TOKEN, bin).toBeUndefined();
      }
    });

    it("skips when an inference-gateway account is pinned (ANTHROPIC_BASE_URL set)", () => {
      storeClaudeOAuthToken(TOKEN, { home });
      const env: Record<string, string> = {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
      };
      applyDefaultClaudeOAuthToken("claude-su", env, { home });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it("respects an explicit user token/key already in the env", () => {
      storeClaudeOAuthToken(TOKEN, { home });
      for (const key of [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
      ]) {
        const env: Record<string, string> = { [key]: "user-supplied" };
        applyDefaultClaudeOAuthToken("claude-su", env, { home });
        // never overwrite what the user explicitly set
        expect(env[key]).toBe("user-supplied");
        if (key !== "CLAUDE_CODE_OAUTH_TOKEN")
          expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      }
    });

    it("prefers the live Linux/Windows system credential file over a possibly stale stored setup token", () => {
      storeClaudeOAuthToken(TOKEN, { home });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"live"}}',
      );

      const linuxEnv: Record<string, string> = {};
      applyDefaultClaudeOAuthToken("claude", linuxEnv, {
        home,
        platform: "linux",
      });
      expect(linuxEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

      // macOS's real login is Keychain-backed under a config-dir-specific
      // suffix, so it still needs the portable stored-token inheritance path.
      const macEnv: Record<string, string> = {};
      applyDefaultClaudeOAuthToken("claude", macEnv, {
        home,
        platform: "darwin",
      });
      expect(macEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    });
  });

  describe("parseArgs — credential maintenance commands", () => {
    it("parses --set-claude-token (bare, prompts for a paste)", () => {
      const a = parseArgs(["--set-claude-token"]);
      expect(a.setClaudeToken).toBe(true);
      expect(a.setClaudeTokenValue).toBeNull();
    });

    it("parses the inline --set-claude-token=<token> scripting form", () => {
      const a = parseArgs([`--set-claude-token=${TOKEN}`]);
      expect(a.setClaudeToken).toBe(true);
      expect(a.setClaudeTokenValue).toBe(TOKEN);
    });

    it("parses --clear-claude-token", () => {
      expect(parseArgs(["--clear-claude-token"]).clearClaudeToken).toBe(true);
    });
  });
});

// fleet-recolor-and-color-hardening P-005: the launcher derives a fleet slug
// CLIENT-side (psu-launcher.mjs — a plain-node script that can't import the TS
// store) and the server RE-DERIVES it authoritatively (agent-fleets-store.ts).
// The two carry a "MIRRORS … keep in sync" comment but no guard, so a divergence
// would silently mislabel the picker's new-fleet preview. Pin them identical.
describe("effectiveAutoMode (WI-1356 fleet-auto-mode)", () => {
  it("defaults AUTO ON for a --fleet launch (member has no human at the keyboard)", () => {
    expect(effectiveAutoMode(parseArgs(["--fleet=x"]))).toBe(true);
  });
  it("is OFF for a plain (non-fleet) launch", () => {
    expect(
      effectiveAutoMode(parseArgs(["--no-picker", "--agent=claude"])),
    ).toBe(false);
  });
  it("--auto forces it on even without a fleet; --no-auto forces it off even with a fleet", () => {
    expect(effectiveAutoMode(parseArgs(["--auto"]))).toBe(true);
    expect(effectiveAutoMode(parseArgs(["--fleet=x", "--no-auto"]))).toBe(
      false,
    );
  });
});

// WI-1408 (fleet-join-startup-assertion): the direct-member-launch client path
// (`psu --fleet=<slug>`) — bootstrap-su/-role already hard-fail (409) a fleet
// join that failed to resolve server-side, which `api()` surfaces as a thrown
// Error before `assertFleetJoined` even runs. This is the defense-in-depth
// guard for the OTHER failure mode: a response that comes back `status: 'ok'`
// but with `fleetSlug` still null — the exact "recolours the terminal but
// never persists membership" bug the fix exists to prevent.
describe("assertFleetJoined (WI-1408 fleet-join-startup-assertion)", () => {
  it("no fleet requested ⇒ never throws, whatever the response carries", () => {
    expect(() => assertFleetJoined(null, {})).not.toThrow();
    expect(() =>
      assertFleetJoined(undefined, { fleetSlug: null }),
    ).not.toThrow();
  });

  it("fleet requested + response carries a non-null fleetSlug ⇒ passes silently", () => {
    expect(() =>
      assertFleetJoined("shared-hive-testing", {
        fleetSlug: "shared-hive-testing",
        fleetRole: "member",
      }),
    ).not.toThrow();
  });

  it("fleet requested (join) but response fleetSlug is null ⇒ throws — never a silent unfleeted launch", () => {
    expect(() =>
      assertFleetJoined("shared-hive-testing", { fleetSlug: null }),
    ).toThrow(/shared-hive-testing/);
  });

  it("fleet requested via a fresh --fleet-name create but response fleetSlug is null ⇒ throws", () => {
    expect(() =>
      assertFleetJoined("My New Fleet", { fleetSlug: null }),
    ).toThrow(/My New Fleet/);
  });

  // Staging-launcher / release-server skew: a pre-WI-1408 operator registers the
  // membership (env + pending-fleet row) but does not echo `fleetSlug` at all.
  // Killing the member then is wrong (the 2026-07-01 10-member wipeout) — the
  // hard-fail is reserved for a server that SPEAKS the field and says null.
  it("fleet requested but the response predates the fleetSlug field entirely ⇒ warns, does not throw", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => assertFleetJoined("shared-hive-testing", {})).not.toThrow();
      expect(() =>
        assertFleetJoined("shared-hive-testing", {
          status: "ok",
          fleetNotice: "joined fleet shared-hive-testing as member.",
        }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("predates the fleetSlug field"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("psuLaunchArgvRecord (WI-1343 launch_argv reconstruction)", () => {
  it("reconstructs the canonical psu invocation from resolved selections", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=h1",
      "--plan=p1",
    ]);
    expect(
      psuLaunchArgvRecord(
        { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
        args,
      ),
    ).toEqual([
      "psu",
      "--no-picker",
      "--agent=claude",
      "--workspace=ws1",
      "--harness=h1",
      "--plan=p1",
    ]);
  });
  it("emits --no-plan when no plan is bound", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=omp",
      "--harness=h1",
      "--no-plan",
    ]);
    const argv = psuLaunchArgvRecord(
      { agent: "omp", workspace: null, harness: "h1", plan: null },
      args,
    );
    expect(argv).toContain("--no-plan");
    expect(argv).not.toContain("--workspace=null");
  });
  it("records the explicit --headless launch discriminator", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=h1",
      "--no-plan",
      "--headless",
      "--carry=cold",
    ]);
    const argv = psuLaunchArgvRecord(
      { agent: "claude", workspace: null, harness: "h1", plan: null },
      args,
    );
    expect(argv).toContain("--headless");
    expect(argv).toContain("--carry=cold");
    expect(args.carry).toBe("cold");
  });
  it("rejects an invalid fleet carry attestation instead of recording a lie", () => {
    expect(() => parseArgs(["--no-picker", "--carry=lukewarm"])).toThrow(
      /warm\|cold/,
    );
  });
  it("captures fleet, account, profile, context-size, model, add-dir and passthrough", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=h1",
      "--plan=p1",
      "--fleet=shared-hive-testing",
      "--account=acct1",
      "--profile=power",
      "--context-size=trimmed",
      "--model=opus",
      "--add-dir=/x",
      "--",
      "--verbose",
    ]);
    const argv = psuLaunchArgvRecord(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      args,
    );
    // opus normalizes to opus[1m] at parse — the recorded relaunch argv must carry
    // the marker so a re-launch reproduces the 1M window (owner directive 2026-07-02).
    expect(argv).toEqual(
      expect.arrayContaining([
        "--fleet=shared-hive-testing",
        "--account=acct1",
        "--profile=power",
        "--context-size=trimmed",
        "--model=opus[1m]",
        "--add-dir=/x",
        "--auto",
        "--",
        "--verbose",
      ]),
    );
  });
  it("derives --fleet from a picker-entered fleet NAME", () => {
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=h1",
      "--plan=p1",
    ]);
    args.fleetName = "My New Fleet";
    const argv = psuLaunchArgvRecord(
      { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
      args,
    );
    expect(argv).toContain(`--fleet=${storeFleetSlugFromName("My New Fleet")}`);
  });
  it("captures --allow-subagents (owner mandate 2026-07-02); omitted when not opted in (deny is the default)", () => {
    const withFlag = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=h1",
      "--plan=p1",
      "--allow-subagents",
    ]);
    expect(
      psuLaunchArgvRecord(
        { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
        withFlag,
      ),
    ).toContain("--allow-subagents");
    const withoutFlag = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--harness=h1",
      "--plan=p1",
    ]);
    expect(
      psuLaunchArgvRecord(
        { agent: "claude", workspace: "ws1", harness: "h1", plan: "p1" },
        withoutFlag,
      ),
    ).not.toContain("--allow-subagents");
  });
});

describe("resumeLaunchArgvRecord (EI-22441173036886852)", () => {
  it("refreshes the effective account/model while retaining durable resume placement", () => {
    const argv = resumeLaunchArgvRecord(
      {
        id: 22496,
        agent: "claude",
        workspaceId: "papercusp-workspace",
        harnessSlug: "papercusp",
        planSlug: null,
        launchArgv: [
          "psu",
          "--no-picker",
          "--resume=22496",
          "--agent=claude",
          "--account=default",
          "--fleet=shared-hive",
          "--carry=warm",
        ],
      },
      {
        account: { mode: "auto", forward: "auto", id: null },
        model: "opus[1m]:max",
      },
    );

    expect(argv).toEqual(
      expect.arrayContaining([
        "--resume=22496",
        "--agent=claude",
        "--account=auto",
        "--model=opus[1m]:max",
        "--fleet=shared-hive",
        "--carry=warm",
      ]),
    );
    expect(argv).not.toContain("--account=default");
  });

  it("removes a stale model when the resume explicitly selects the backend default", () => {
    const argv = resumeLaunchArgvRecord(
      {
        id: 22497,
        agent: "claude",
        launchArgv: [
          "psu",
          "--no-picker",
          "--resume=22497",
          "--agent=claude",
          "--model=opus[1m]:max",
        ],
      },
      { account: { mode: "default" }, model: null },
    );

    expect(argv).not.toContain("--model=opus[1m]:max");
    expect(argv).toContain("--account=default");
  });

  it("records inherited Codex model provenance on an exact unattended resume", () => {
    const argv = resumeLaunchArgvRecord(
      {
        id: 22498,
        agent: "codex",
        launchArgv: [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--model=gpt-5.6-terra:high",
          "--model-source=explicit",
        ],
      },
      {
        account: { mode: "default" },
        model: "gpt-5.6-terra:high",
        modelSource: "inherited",
      },
    );

    expect(argv).toContain("--model=gpt-5.6-terra:high");
    expect(argv).toContain("--model-source=inherited");
    expect(argv).toContain("--headless");
  });
});

describe("fleetSlugFromName client/server parity", () => {
  const NAMES = [
    "Ops Team",
    "k-epochs",
    "  Trailing/Leading  ",
    "UPPER CASE NAME",
    "weird!!!chars@@@here",
    "émoji ✨ and àccents",
    "---only-dashes---",
    "!!!",
    "a".repeat(80),
    "mixed_Under-scores and.dots",
    "single",
  ];
  it.each(NAMES)("derives the same slug for %j on client + server", (name) => {
    expect(launcherFleetSlugFromName(name)).toBe(storeFleetSlugFromName(name));
  });
});

// fleet-recolor-and-color-hardening P-004: the psu picker shows a color swatch
// per fleet (from /options' resolved scheme). hexToRgb + colorSwatch are the pure
// rendering helpers.
describe("picker color swatch (fleet-color-schemes)", () => {
  it("hexToRgb parses #rrggbb (with or without #), case-insensitively", () => {
    expect(hexToRgb("#166534")).toEqual([22, 101, 52]);
    expect(hexToRgb("166534")).toEqual([22, 101, 52]);
    expect(hexToRgb("#FFFFFF")).toEqual([255, 255, 255]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
  });
  it("hexToRgb returns null for malformed input", () => {
    expect(hexToRgb("")).toBeNull();
    expect(hexToRgb("#fff")).toBeNull();
    expect(hexToRgb("nope")).toBeNull();
    expect(hexToRgb(null)).toBeNull();
    expect(hexToRgb(undefined)).toBeNull();
  });
  it("colorSwatch builds a truecolor 48;2 background cell from a scheme bg", () => {
    expect(
      colorSwatch({ bg: "#166534", fg: "#dcfce7", cursor: "#86efac" }),
    ).toBe("\x1b[48;2;22;101;52m  \x1b[0m ");
  });
  it("colorSwatch is empty (graceful) when there is no/invalid color", () => {
    expect(colorSwatch(null)).toBe("");
    expect(colorSwatch(undefined)).toBe("");
    expect(colorSwatch({ bg: "not-a-hex" })).toBe("");
    expect(colorSwatch({})).toBe("");
  });
  it("schemeNameInAccent renders the name in the cursor accent (truecolor fg), plain on bad color", () => {
    // The scheme-picker row label: the name in the scheme's cursor accent.
    expect(schemeNameInAccent({ name: "forest", cursor: "#86efac" })).toBe(
      "\x1b[38;2;134;239;172mforest\x1b[0m",
    );
    // Unparseable/absent color → plain name (still selectable, just uncolored).
    expect(schemeNameInAccent({ name: "forest", cursor: "nope" })).toBe(
      "forest",
    );
    expect(schemeNameInAccent(null)).toBe("");
    expect(schemeNameInAccent({ name: "x" })).toBe("x");
  });
});

describe("launch preflight guards (context-trimming-tiers P-016 / P-018)", () => {
  it("assertLaunchPersona: missing / absent / tiny prompt files fail LOUD; a real one returns its size", () => {
    expect(() => assertLaunchPersona(null)).toThrow(/no persona prompt file/i);
    expect(() => assertLaunchPersona("/nonexistent/persona.md")).toThrow(
      /missing\/unreadable/,
    );
    const dir = mkdtempSync(join(tmpdir(), "psu-p016-"));
    const tiny = join(dir, "tiny.md");
    writeFileSync(tiny, "# stub");
    expect(() => assertLaunchPersona(tiny)).toThrow(/did not render\/append/);
    const real = join(dir, "real.md");
    writeFileSync(real, "x".repeat(5_000));
    expect(assertLaunchPersona(real)).toBe(5_000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("preflightWindowGuard: warn ≥35%, refuse ≥60%, [1m] widens the window", () => {
    // trimmed baseline 55k + ~13.5k persona ≈ 68.5k of 200k ≈ 34% → ok
    const ok = preflightWindowGuard({
      personaBytes: 50_000,
      contextSize: "trimmed",
      model: "haiku",
    });
    expect(ok.level).toBe("ok");
    // full baseline 152k + ~28k persona ≈ 180k of 200k = 90% → refuse
    const refuse = preflightWindowGuard({
      personaBytes: 105_000,
      contextSize: "full",
      model: "haiku",
    });
    expect(refuse.level).toBe("refuse");
    // same on a [1m] window → 18% → ok
    const wide = preflightWindowGuard({
      personaBytes: 105_000,
      contextSize: "full",
      model: "haiku[1m]",
    });
    expect(wide.level).toBe("ok");
    // trimmed + a big persona lands the warn band (55k + 27k ≈ 82k = 41%)
    const warn = preflightWindowGuard({
      personaBytes: 100_000,
      contextSize: "trimmed",
      model: "haiku",
    });
    expect(warn.level).toBe("warn");
  });

  it("preflightWindowGuard: default-1M families (sonnet-5 incl. the bare alias, opus, fable) get the 1M window without [1m]", () => {
    for (const model of [
      "claude-sonnet-5:high",
      "sonnet:medium",
      "sonnet",
      "opus:high",
      "claude-fable-5:xhigh",
    ]) {
      const g = preflightWindowGuard({
        personaBytes: 105_000,
        contextSize: "full",
        model,
      });
      expect(g.window).toBe(1_000_000);
      expect(g.level).toBe("ok");
    }
    // versioned sonnet ≤4.x stays on the conservative 200k window
    expect(
      preflightWindowGuard({
        personaBytes: 105_000,
        contextSize: "full",
        model: "claude-sonnet-4-6:high",
      }).window,
    ).toBe(200_000);
  });

  it("preflightWindowGuard consumes the bootstrap budget verbatim", () => {
    const budget = {
      version: 1,
      window: 272_000,
      windowSource: "codex-model-cache",
      baselineTokens: 68_000,
      pct: 0.25,
      level: "ok",
    };
    const guard = preflightWindowGuard({
      personaBytes: 999_999,
      contextSize: "full",
      model: "ignored",
      agent: "codex",
      budget,
    });
    expect(guard).toMatchObject({
      window: 272_000,
      estTokens: 68_000,
      pct: 0.25,
      level: "ok",
    });
    expect(guard.budget).toBe(budget);
  });

  it("runLaunchPreflight: legacy full uses the trimmed budget instead of the eager-full refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "psu-p018-"));
    const persona = join(dir, "persona.md");
    writeFileSync(persona, "x".repeat(105_000));
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = runLaunchPreflight({
      promptFile: persona,
      contextSize: "full",
      model: "haiku",
      force: false,
    });
    expect(g.level).toBe("warn");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runLaunchPreflight: legacy full normalizes before the Codex transport preflight", () => {
    const dir = mkdtempSync(join(tmpdir(), "psu-wi39948-"));
    const persona = join(dir, "persona.md");
    writeFileSync(persona, "x".repeat(5_000));

    expect(() =>
      runLaunchPreflight({
        promptFile: persona,
        contextSize: "full",
        model: "gpt-5.6-luna:max",
        agent: "codex",
        force: true,
      }),
    ).not.toThrow();

    expect(() =>
      runLaunchPreflight({
        promptFile: persona,
        contextSize: "trimmed",
        model: "gpt-5.6-luna:max",
        agent: "codex",
        force: false,
      }),
    ).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it("parseArgs: --persona-tier + --force parse (P-017/P-018)", () => {
    expect(parseArgs([]).personaTier).toBeNull();
    expect(parseArgs(["--persona-tier=fleet"]).personaTier).toBe("fleet");
    expect(parseArgs([]).force).toBe(false);
    expect(parseArgs(["--force"]).force).toBe(true);
  });
});

describe("--launched-by (solo-launch-provenance)", () => {
  it("parseArgs captures --launched-by=<ownerId>", async () => {
    const { parseArgs } = await import("../scripts/psu-launcher.mjs");
    const a = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--launched-by=su-94b69875-x",
    ]);
    expect(a.launchedBy).toBe("su-94b69875-x");
    expect(parseArgs([]).launchedBy).toBeNull();
  });

  it("freshSuBootstrapBody forwards launched_by so bootstrap-su can bake provenance", async () => {
    const { parseArgs, freshSuBootstrapBody } =
      await import("../scripts/psu-launcher.mjs");
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--launched-by=su-abc",
    ]);
    const body = freshSuBootstrapBody(
      { agent: "claude", workspace: "w", harness: "h", plan: null },
      args,
    );
    expect(body.launched_by).toBe("su-abc");
    // and omitted entirely when absent (server treats absent as null)
    const bare = freshSuBootstrapBody(
      { agent: "claude", workspace: "w", harness: "h", plan: null },
      parseArgs(["--no-picker", "--agent=claude"]),
    );
    expect("launched_by" in bare).toBe(false);
  });

  it("psuLaunchArgvRecord round-trips --launched-by (WI-1343 reconstruction)", async () => {
    const { parseArgs, psuLaunchArgvRecord } =
      await import("../scripts/psu-launcher.mjs");
    const args = parseArgs([
      "--no-picker",
      "--agent=claude",
      "--launched-by=su-abc",
    ]);
    const argv = psuLaunchArgvRecord(
      { agent: "claude", workspace: "w", harness: "h", plan: null },
      args,
    );
    expect(argv).toContain("--launched-by=su-abc");
  });
});

describe('setupReminderLines — pre-TUI "setup unfinished" nudge (owner batch #5)', () => {
  it("returns null when setup is complete (stage done) — no nag", () => {
    expect(setupReminderLines("done")).toBeNull();
  });
  it("returns null when the stage is unknown (probe failed / operator unreachable)", () => {
    // A failed/timed-out probe resolves to null — never nag on no signal.
    expect(setupReminderLines(null)).toBeNull();
    expect(setupReminderLines(undefined)).toBeNull();
    expect(setupReminderLines("")).toBeNull();
  });
  it("nudges for every not-done concierge stage, naming BOTH `papercusp setup` and `papercusp tutorial`", () => {
    for (const stage of ["pick", "install", "login", "embeddings", "handoff"]) {
      const lines = setupReminderLines(stage);
      expect(lines, stage).not.toBeNull();
      const text = lines.join("\n");
      expect(text, stage).toContain("papercusp setup");
      expect(text, stage).toContain("papercusp tutorial");
      // States the WHY (locked functionality) so the nudge is actionable, not noise.
      expect(text.toLowerCase(), stage).toContain("locked");
    }
  });
});

// psu-resume-relogin (owner-reported 2026-07-12): a default-account `psu --resume`
// re-heals the isolated CLAUDE_CONFIG_DIR's .credentials.json to the global CLI
// login before spawn — the fresh-launch mirror invariant that a raw resume skipped,
// which made a resumed session "launch logged out" once its in-session OAuth refresh
// forked the symlink into a stale real file.
describe("rehealResumeCredentials (psu-resume-relogin)", () => {
  let home: string;
  const CREDS = (exp: number) =>
    JSON.stringify({
      claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: exp },
    });
  const globalOf = () => join(home, ".claude", ".credentials.json");
  const sessCredOf = (dir: string) => join(dir, ".credentials.json");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reheal-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** A fresh isolated session dir under `home` (so afterEach cleans it). */
  function makeSessionDir(): string {
    return mkdtempSync(join(home, "sess-"));
  }

  it("re-points a stale real-file fork at the newer global via symlink", () => {
    writeFileSync(globalOf(), CREDS(2000)); // reconciler keeps the global newest
    const dir = makeSessionDir();
    writeFileSync(sessCredOf(dir), CREDS(1000)); // stale in-session fork
    rehealResumeCredentials(dir, { home });
    expect(lstatSync(sessCredOf(dir)).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessCredOf(dir))).toBe(realpathSync(globalOf()));
    expect(claudeCredExpiresAt(sessCredOf(dir))).toBe(2000); // resolves to the live token
  });

  it("leaves a healthy symlink-to-global untouched (idempotent)", () => {
    writeFileSync(globalOf(), CREDS(2000));
    const dir = makeSessionDir();
    symlinkSync(globalOf(), sessCredOf(dir));
    const before = readlinkSync(sessCredOf(dir));
    rehealResumeCredentials(dir, { home });
    expect(lstatSync(sessCredOf(dir)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(sessCredOf(dir))).toBe(before);
  });

  it("re-points a dangling symlink at the global", () => {
    writeFileSync(globalOf(), CREDS(2000));
    const dir = makeSessionDir();
    symlinkSync(join(home, ".claude", "gone.json"), sessCredOf(dir)); // dangling
    rehealResumeCredentials(dir, { home });
    expect(realpathSync(sessCredOf(dir))).toBe(realpathSync(globalOf()));
  });

  it("creates the symlink when the session dir has no credential file", () => {
    writeFileSync(globalOf(), CREDS(2000));
    const dir = makeSessionDir();
    rehealResumeCredentials(dir, { home });
    expect(realpathSync(sessCredOf(dir))).toBe(realpathSync(globalOf()));
  });

  it("promotes a strictly-newer session fork to the global, then symlinks (newest-wins)", () => {
    writeFileSync(globalOf(), CREDS(1000)); // global stale (reconciler lagged)
    const dir = makeSessionDir();
    writeFileSync(sessCredOf(dir), CREDS(3000)); // session refreshed most recently
    rehealResumeCredentials(dir, { home });
    expect(claudeCredExpiresAt(globalOf())).toBe(3000); // promoted so global stays canonical
    expect(realpathSync(sessCredOf(dir))).toBe(realpathSync(globalOf()));
    expect(claudeCredExpiresAt(sessCredOf(dir))).toBe(3000);
  });

  it("is a no-op (no throw) when there is no global credential file (API-key box)", () => {
    const dir = makeSessionDir();
    writeFileSync(sessCredOf(dir), CREDS(1000)); // no global written
    expect(() => rehealResumeCredentials(dir, { home })).not.toThrow();
    expect(lstatSync(sessCredOf(dir)).isSymbolicLink()).toBe(false); // left as-is, nothing to mirror
  });

  it("claudeCredExpiresAt reads expiresAt and returns -1 on unreadable/missing", () => {
    const dir = makeSessionDir();
    const p = sessCredOf(dir);
    writeFileSync(p, CREDS(4242));
    expect(claudeCredExpiresAt(p)).toBe(4242);
    expect(claudeCredExpiresAt(join(dir, "nope.json"))).toBe(-1);
  });
});

describe("re-exec-safe permissions (mcp-transport-resilience P-002, 2026-07-13)", () => {
  it("derives defaultMode from --dangerously-skip-permissions and --permission-mode (both forms)", () => {
    expect(
      reExecSafePermissionsFromArgs(["--dangerously-skip-permissions"]),
    ).toEqual({
      defaultMode: "bypassPermissions",
      deny: [],
    });
    expect(
      reExecSafePermissionsFromArgs(["--permission-mode", "plan"]),
    ).toEqual({
      defaultMode: "plan",
      deny: [],
    });
    expect(
      reExecSafePermissionsFromArgs(["--permission-mode=acceptEdits"]),
    ).toEqual({
      defaultMode: "acceptEdits",
      deny: [],
    });
  });

  it("unions repeated --disallowedTools occurrences and dedups (claude unions them too)", () => {
    const derived = reExecSafePermissionsFromArgs([
      NATIVE_SCHEDULER_DENY_FLAG,
      NO_SUBAGENTS_DENY_FLAG,
      "--disallowedTools",
      "Task,ExtraTool",
    ]);
    expect(derived).not.toBeNull();
    expect(derived!.deny).toContain("CronCreate");
    expect(derived!.deny).toContain("Task");
    expect(derived!.deny).toContain("Workflow");
    expect(derived!.deny).toContain("ExtraTool");
    // deduped: Task appears in NO_SUBAGENTS_DENY_FLAG and the space-form list
    expect(derived!.deny.filter((t: string) => t === "Task")).toHaveLength(1);
  });

  it("returns null when the argv expresses no permissions (nothing to persist)", () => {
    expect(
      reExecSafePermissionsFromArgs(["--session-id", "abc", "--model", "opus"]),
    ).toBeNull();
    expect(reExecSafePermissionsFromArgs([])).toBeNull();
  });

  describe("persistReExecSafePermissions (IO leg)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "psu-reexec-perms-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("writes permissions into the isolated CLAUDE_CONFIG_DIR settings.json", () => {
      const ok = persistReExecSafePermissions({
        env: { CLAUDE_CONFIG_DIR: dir },
        args: ["--dangerously-skip-permissions", NO_SUBAGENTS_DENY_FLAG],
      });
      expect(ok).toBe(true);
      const written = JSON.parse(
        readFileSync(join(dir, "settings.json"), "utf8"),
      );
      expect(written.permissions.defaultMode).toBe("bypassPermissions");
      expect(written.permissions.deny).toContain("Workflow");
    });

    it("preserves unrelated settings keys and UNIONS an existing deny (never removes)", () => {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          statusLine: { type: "command", command: "x" },
          permissions: { deny: ["HandEdit"] },
        }),
      );
      const ok = persistReExecSafePermissions({
        env: { CLAUDE_CONFIG_DIR: dir },
        args: [NATIVE_SCHEDULER_DENY_FLAG],
      });
      expect(ok).toBe(true);
      const written = JSON.parse(
        readFileSync(join(dir, "settings.json"), "utf8"),
      );
      expect(written.statusLine).toEqual({ type: "command", command: "x" });
      expect(written.permissions.deny).toContain("HandEdit"); // pre-existing human entry kept
      expect(written.permissions.deny).toContain("CronCreate");
    });

    it("NEVER writes without an isolated config dir (no bleed into shared ~/.claude)", () => {
      const ok = persistReExecSafePermissions({
        env: {},
        args: ["--dangerously-skip-permissions"],
      });
      expect(ok).toBe(false);
    });

    it("no-ops (false) when the argv expresses no permissions", () => {
      const ok = persistReExecSafePermissions({
        env: { CLAUDE_CONFIG_DIR: dir },
        args: [],
      });
      expect(ok).toBe(false);
      expect(existsSync(join(dir, "settings.json"))).toBe(false);
    });

    it("fail-open: unwritable dir warns and returns false, never throws", () => {
      const logs: string[] = [];
      const ok = persistReExecSafePermissions({
        env: { CLAUDE_CONFIG_DIR: join(dir, "nope", "deeper") },
        args: ["--dangerously-skip-permissions"],
        log: (m: string) => logs.push(m),
      });
      expect(ok).toBe(false);
      expect(logs.join("")).toContain("re-exec-safe permissions");
    });
  });

  describe("persistDefaultClaudeAuthSettings (re-exec durable explicit routing)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "psu-default-auth-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("removes copied credential/provider settings while preserving unrelated settings", () => {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          apiKeyHelper: "/tmp/old-helper",
          env: {
            ANTHROPIC_API_KEY: "old-key",
            CLAUDE_CODE_OAUTH_TOKEN: "old-oauth",
            CLAUDE_CODE_USE_BEDROCK: "1",
            KEEP_ME: "yes",
          },
          statusLine: { type: "command", command: "x" },
        }),
      );
      const ok = persistDefaultClaudeAuthSettings({
        wrapperBin: "claude",
        env: { CLAUDE_CONFIG_DIR: dir, ...defaultAccountEnv() },
      });
      expect(ok).toBe(true);
      const written = JSON.parse(
        readFileSync(join(dir, "settings.json"), "utf8"),
      );
      expect(written.apiKeyHelper).toBe("");
      expect(written.env).toEqual({ KEEP_ME: "yes" });
      expect(written.statusLine).toEqual({ type: "command", command: "x" });
    });

    it("persists an auto route and removes conflicting provider selectors", () => {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          env: {
            CLAUDE_CODE_USE_BEDROCK: "1",
            ANTHROPIC_API_KEY: "old",
            KEEP_ME: "yes",
          },
        }),
      );
      const auto = gatewayAutoEnv("claude", "su-auto");
      expect(
        persistDefaultClaudeAuthSettings({
          wrapperBin: "claude",
          env: { CLAUDE_CONFIG_DIR: dir, ...auto },
        }),
      ).toBe(true);
      const written = JSON.parse(
        readFileSync(join(dir, "settings.json"), "utf8"),
      );
      expect(written.env).toMatchObject({
        KEEP_ME: "yes",
        ANTHROPIC_BASE_URL: auto.ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
        ANTHROPIC_CUSTOM_HEADERS: `${OWNER_HEADER}: su-auto`,
      });
      expect(written.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(written.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("does not mutate an unselected route, non-Claude, or shared-user settings", () => {
      expect(
        persistDefaultClaudeAuthSettings({
          wrapperBin: "claude",
          env: { CLAUDE_CONFIG_DIR: dir },
        }),
      ).toBe(false);
      expect(
        persistDefaultClaudeAuthSettings({
          wrapperBin: "omp",
          env: { CLAUDE_CONFIG_DIR: dir, ...defaultAccountEnv() },
        }),
      ).toBe(false);
      expect(
        persistDefaultClaudeAuthSettings({
          wrapperBin: "claude",
          env: defaultAccountEnv(),
        }),
      ).toBe(false);
      expect(existsSync(join(dir, "settings.json"))).toBe(false);
    });
  });
});

describe("effectiveWindow derivation (deterministic-context-carry P-005 — live backend n_ctx clamp)", () => {
  const ORNITH_YML = [
    "providers:",
    "  anthropic:",
    "    models:",
    "      - id: claude-opus-4-8",
    "        contextWindow: 1000000",
    "  ollama-cc:",
    "    baseUrl: http://127.0.0.1:8788/v1",
    "    models:",
    "      - id: maxwell1500/ornith-35b:IQ3_M",
    "        name: Ornith 35B IQ3_M",
    "        contextWindow: 200000",
    "        maxTokens: 8192",
    "      - id: ornith:fast",
    "        contextWindow: 200000",
    "",
  ].join("\n");
  const ORNITH_JSON = JSON.stringify(
    {
      models: [
        { id: "maxwell1500/ornith-35b:IQ3_M", contextWindow: 57344 },
        { id: "ornith:fast", contextWindow: 57344 },
        { id: "claude-opus-4-8", contextWindow: 1000000 },
      ],
    },
    null,
    2,
  );

  it("bareOmpModelId strips the local provider prefix and a trailing reasoning-effort suffix", () => {
    expect(bareOmpModelId("ollama-cc/maxwell1500/ornith-35b:IQ3_M")).toBe(
      "maxwell1500/ornith-35b:IQ3_M",
    );
    expect(bareOmpModelId("ollama-cc/maxwell1500/ornith-35b:IQ3_M:xhigh")).toBe(
      "maxwell1500/ornith-35b:IQ3_M",
    );
    expect(bareOmpModelId("ollama/ornith:high")).toBe("ornith");
    // a hosted id keeps its provider (it is not a local prefix) — only the effort suffix goes
    expect(bareOmpModelId("anthropic/claude-opus-4-8:high")).toBe(
      "anthropic/claude-opus-4-8",
    );
    expect(bareOmpModelId("")).toBe("");
  });

  it("readModelsYmlContextWindow reads ONLY the named entry (siblings invisible)", () => {
    expect(
      readModelsYmlContextWindow(ORNITH_YML, "maxwell1500/ornith-35b:IQ3_M"),
    ).toBe(200000);
    expect(readModelsYmlContextWindow(ORNITH_YML, "claude-opus-4-8")).toBe(
      1000000,
    );
    expect(readModelsYmlContextWindow(ORNITH_YML, "not-a-model")).toBe(null);
  });

  it("rewriteModelsYmlContextWindow rewrites ONLY the named entry, byte-preserving the rest", () => {
    const out = rewriteModelsYmlContextWindow(
      ORNITH_YML,
      "maxwell1500/ornith-35b:IQ3_M",
      123456,
    );
    expect(
      readModelsYmlContextWindow(out, "maxwell1500/ornith-35b:IQ3_M"),
    ).toBe(123456);
    expect(readModelsYmlContextWindow(out, "ornith:fast")).toBe(200000);
    expect(readModelsYmlContextWindow(out, "claude-opus-4-8")).toBe(1000000);
    expect(out).toContain("maxTokens: 8192");
    // absent entry → unchanged input
    expect(rewriteModelsYmlContextWindow(ORNITH_YML, "nope", 1)).toBe(
      ORNITH_YML,
    );
  });

  it("rewriteModelsJsonContextWindow sets every record with the id; parse failure returns input", () => {
    const out = JSON.parse(
      rewriteModelsJsonContextWindow(
        ORNITH_JSON,
        "maxwell1500/ornith-35b:IQ3_M",
        200000,
      ),
    );
    expect(out.models[0].contextWindow).toBe(200000);
    expect(out.models[1].contextWindow).toBe(57344);
    expect(out.models[2].contextWindow).toBe(1000000);
    expect(rewriteModelsJsonContextWindow("not json", "x", 1)).toBe("not json");
  });

  it("probeOmpBackendContextWindow hits the gateway probe with the BARE id and returns nCtx", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => ({ ok: true, nCtx: 204800, totalSlots: 3 }),
      };
    }) as unknown as typeof fetch;
    const n = await probeOmpBackendContextWindow(
      "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
      { PAPERCUSP_GATEWAY_PORT: "8797" } as NodeJS.ProcessEnv,
      fetchImpl,
    );
    expect(n).toBe(204800);
    expect(calls[0]).toBe(
      `http://127.0.0.1:8797/maintenance/backend-context?model=${encodeURIComponent("maxwell1500/ornith-35b:IQ3_M")}`,
    );
  });

  it("probeOmpBackendContextWindow is fail-soft: non-ok, garbage nCtx, and thrown fetch all → null", async () => {
    const notOk = (async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const garbage = (async () => ({
      ok: true,
      json: async () => ({ nCtx: "many" }),
    })) as unknown as typeof fetch;
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await probeOmpBackendContextWindow(
        "ollama/ornith",
        {} as NodeJS.ProcessEnv,
        notOk,
      ),
    ).toBe(null);
    expect(
      await probeOmpBackendContextWindow(
        "ollama/ornith",
        {} as NodeJS.ProcessEnv,
        garbage,
      ),
    ).toBe(null);
    expect(
      await probeOmpBackendContextWindow(
        "ollama/ornith",
        {} as NodeJS.ProcessEnv,
        boom,
      ),
    ).toBe(null);
  });

  describe("writeOmpSessionConfigDir backendWindow clamp", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "psu-effwin-"));
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".omp", "agent", "config.yml"),
        "modelRoles:\n  default: ollama-cc/maxwell1500/ornith-35b:IQ3_M\n",
      );
      writeFileSync(join(home, ".omp", "agent", "models.yml"), ORNITH_YML);
      writeFileSync(join(home, ".omp", "agent", "models.json"), ORNITH_JSON);
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));
    const read = (f: string) =>
      readFileSync(
        join(home, ".papercusp", "su-omp-homes", "session-s1", "agent", f),
        "utf8",
      );

    it("configured < backend → effective stays configured; models.json stale value is ALIGNED (three-way conflict eliminated)", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {}); // the informational door line
      const dir = writeOmpSessionConfigDir(
        "s1",
        {
          model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
          backendWindow: 204800,
        },
        home,
      );
      err.mockRestore();
      expect(dir).toBeTruthy();
      expect(
        readModelsYmlContextWindow(
          read("models.yml"),
          "maxwell1500/ornith-35b:IQ3_M",
        ),
      ).toBe(200000);
      const j = JSON.parse(read("models.json"));
      expect(j.models[0].contextWindow).toBe(200000); // was the stale 57344
      expect(j.models[2].contextWindow).toBe(1000000); // hosted sibling untouched
    });

    it("configured > backend → LOUD config error + clamp to the live backend window in BOTH registry copies", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        writeOmpSessionConfigDir(
          "s1",
          {
            model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
            backendWindow: 57344,
          },
          home,
        );
        expect(
          readModelsYmlContextWindow(
            read("models.yml"),
            "maxwell1500/ornith-35b:IQ3_M",
          ),
        ).toBe(57344);
        expect(JSON.parse(read("models.json")).models[0].contextWindow).toBe(
          57344,
        );
        const msgs = err.mock.calls.map((c) => String(c[0])).join("\n");
        expect(msgs).toMatch(/CONFIG ERROR/);
        expect(msgs).toMatch(/EXCEEDS the live backend window 57344/);
      } finally {
        err.mockRestore();
      }
    });

    it("no backendWindow (probe miss / hosted model) → registry copied VERBATIM (pre-P-005 behavior)", () => {
      writeOmpSessionConfigDir(
        "s1",
        { model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M" },
        home,
      );
      expect(read("models.yml")).toBe(ORNITH_YML);
      expect(read("models.json")).toBe(ORNITH_JSON);
    });

    it("P-007: shake thresholdPercent is DERIVED from the effective window when the backend was probed (hard tier = w − maxTurn)", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {}); // informational door line
      try {
        writeOmpSessionConfigDir(
          "s1",
          {
            model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
            backendWindow: 204800,
          },
          home,
        );
        // effective = min(configured 200000, backend 204800) = 200000; maxTurn 8000 → (200000−8000)/200000 = 96%
        expect(read("config.yml")).toMatch(/\n\s+thresholdPercent:\s*96\b/);
      } finally {
        err.mockRestore();
      }
    });

    it("P-007: a deliberately smaller configured window drives the tier (percent from the min, not the raw probe)", () => {
      const smallYml = ORNITH_YML.replace(
        "        contextWindow: 200000\n        maxTokens: 8192",
        "        contextWindow: 57344\n        maxTokens: 8192",
      );
      writeFileSync(join(home, ".omp", "agent", "models.yml"), smallYml);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        writeOmpSessionConfigDir(
          "s1",
          {
            model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M",
            backendWindow: 204800,
          },
          home,
        );
        // effective = 57344; maxTurn 8000 → (57344−8000)/57344 = 86.05 → 86
        expect(read("config.yml")).toMatch(/\n\s+thresholdPercent:\s*86\b/);
      } finally {
        err.mockRestore();
      }
    });

    it("P-007: no probe → the conservative pre-P-007 constant 70 (nothing bounds the hop without the P-005/P-006 chain)", () => {
      writeOmpSessionConfigDir(
        "s1",
        { model: "ollama-cc/maxwell1500/ornith-35b:IQ3_M" },
        home,
      );
      expect(read("config.yml")).toMatch(/\n\s+thresholdPercent:\s*70\b/);
    });
  });

  it("computeCompactionThresholdPercents mirrors the canonical two-tier math (lockstep with context-doors.ts)", () => {
    expect(computeCompactionThresholdPercents(204_800)).toEqual({
      softPct: 90,
      hardPct: 96,
    });
    expect(computeCompactionThresholdPercents(400_000)).toEqual({
      softPct: 91,
      hardPct: 96,
    });
    const d = computeCompactionThresholdPercents(0); // degenerate: sane, never NaN/negative
    expect(d.hardPct).toBeGreaterThanOrEqual(d.softPct);
    expect(d.softPct).toBeGreaterThanOrEqual(0);
  });
});

describe("per-hop output door (deterministic-context-carry P-006 leg (a) — max_tokens via the session registry)", () => {
  it("door mirror math matches the canonical operator-core formula (lockstep with context-doors.ts)", () => {
    expect(computeMaxTurnTokens(204_800)).toBe(8_000); // Ornith → the floor
    expect(computeMaxTurnTokens(1_000_000)).toBe(15_000); // the cap
    expect(computeMaxTurnTokens(260_000)).toBe(10_000); // /26 between the knees
    expect(computeMaxTurnTokens(0)).toBe(8_000); // degenerate → floor, never NaN
    expect(computeOutputDoorTokens(204_800)).toBe(4_000);
    expect(computeOutputDoorTokens(1_000_000)).toBe(7_500);
  });

  it("generalized field helpers: readModelsYmlField / rewriteModelsYmlField / rewriteModelsJsonFields", () => {
    const yml =
      "providers:\n  ollama-cc:\n    models:\n      - id: m1\n        contextWindow: 200000\n        maxTokens: 8192\n";
    expect(readModelsYmlField(yml, "m1", "maxTokens")).toBe(8192);
    const out = rewriteModelsYmlField(yml, "m1", "maxTokens", 4000);
    expect(readModelsYmlField(out, "m1", "maxTokens")).toBe(4000);
    expect(readModelsYmlField(out, "m1", "contextWindow")).toBe(200000);
    const j = JSON.parse(
      rewriteModelsJsonFields(
        JSON.stringify({
          models: [{ id: "m1", contextWindow: 1, maxTokens: 9 }],
        }),
        "m1",
        { contextWindow: 2, maxTokens: 3 },
      ),
    );
    expect(j.models[0]).toEqual({ id: "m1", contextWindow: 2, maxTokens: 3 });
  });

  describe("writeOmpSessionConfigDir applies the output door with the window clamp", () => {
    let home: string;
    const YML = [
      "providers:",
      "  ollama-cc:",
      "    models:",
      "      - id: ornith-x",
      "        contextWindow: 200000",
      "        maxTokens: 8192",
      "      - id: tiny-model",
      "        contextWindow: 200000",
      "        maxTokens: 2048",
      "",
    ].join("\n");
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "psu-door-"));
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".omp", "agent", "config.yml"),
        "modelRoles:\n  default: ollama-cc/ornith-x\n",
      );
      writeFileSync(join(home, ".omp", "agent", "models.yml"), YML);
      writeFileSync(
        join(home, ".omp", "agent", "models.json"),
        JSON.stringify({
          models: [{ id: "ornith-x", contextWindow: 57344, maxTokens: 8192 }],
        }),
      );
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));
    const read = (f: string) =>
      readFileSync(
        join(home, ".papercusp", "su-omp-homes", "session-d1", "agent", f),
        "utf8",
      );

    it("Ornith-class window → max_tokens tightened to the 4K output door in BOTH registry copies", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      writeOmpSessionConfigDir(
        "d1",
        { model: "ollama-cc/ornith-x", backendWindow: 204800 },
        home,
      );
      const doorLine = err.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes("per-hop doors"));
      err.mockRestore();
      expect(doorLine).toMatch(
        /maxTurn 8000 → output door \(max_tokens\) 4000/,
      );
      expect(
        readModelsYmlField(read("models.yml"), "ornith-x", "maxTokens"),
      ).toBe(4000);
      expect(
        readModelsYmlField(read("models.yml"), "ornith-x", "contextWindow"),
      ).toBe(200000);
      const j = JSON.parse(read("models.json"));
      expect(j.models[0]).toEqual({
        id: "ornith-x",
        contextWindow: 200000,
        maxTokens: 4000,
      });
    });

    it("a registry maxTokens BELOW the door is kept (the door only tightens, never raises)", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      writeOmpSessionConfigDir(
        "d1",
        { model: "ollama-cc/tiny-model", backendWindow: 204800 },
        home,
      );
      err.mockRestore();
      expect(
        readModelsYmlField(read("models.yml"), "tiny-model", "maxTokens"),
      ).toBe(2048);
      // the sibling's entry was not touched
      expect(
        readModelsYmlField(read("models.yml"), "ornith-x", "maxTokens"),
      ).toBe(8192);
    });

    it("no backendWindow → registry copied verbatim, no door applied (pre-P-006 behavior)", () => {
      writeOmpSessionConfigDir("d1", { model: "ollama-cc/ornith-x" }, home);
      expect(read("models.yml")).toBe(YML);
    });
  });
});

/**
 * EI-12938 (owner-reported 2026-07-16): `psu --resume` boots claude into the
 * first-run wizard (a /login screen) despite a healthy system login; exit it,
 * re-run, and the second attempt "works".
 *
 * psu's resume leg heals `.credentials.json` (rehealResumeCredentials) — but
 * credentials are not ACCOUNT STATE. `.claude.json` is what claude reads to
 * decide it is signed in, and it carries the user-level MCP servers too. A dir
 * restored from the archive (transcript only) or built for a headless bee
 * (`writeSpawnClaudeConfig` — creds symlink only) has none, so the resume hits
 * the wizard, claude mints a stub, and attempt 2 stops prompting while running
 * TOOL-LESS. These pin the launcher-side glue: detect the degraded dir locally
 * (no round-trip when healthy), delegate the repair to the operator (the mirror
 * has exactly ONE implementation, server-side), and never block a launch.
 */
describe("EI-12938: psu --resume ensures a launch-ready claude config dir", () => {
  let root: string;
  const savedRoot = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "psu-icc-"));
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = root;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedRoot === undefined)
      delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = savedRoot;
  });

  const dirFor = (sid: string) => {
    const d = join(root, sid);
    mkdirSync(d, { recursive: true });
    return d;
  };

  describe("isClaudeConfigDirLaunchReady (the .mjs mirror of the operator-core predicate)", () => {
    it("a mirrored dir (.claude.json symlinked to the real config) is ready", () => {
      const home = mkdtempSync(join(tmpdir(), "psu-icc-home-"));
      writeFileSync(
        join(home, ".claude.json"),
        '{"mcpServers":{"papercusp-su":{}}}',
      );
      const dir = dirFor("su-ok");
      symlinkSync(join(home, ".claude.json"), join(dir, ".claude.json"));
      expect(isClaudeConfigDirLaunchReady(dir)).toBe(true);
      rmSync(home, { recursive: true, force: true });
    });

    it("a rematerialized / bee dir (no .claude.json) is NOT ready", () => {
      expect(isClaudeConfigDirLaunchReady(dirFor("su-remat"))).toBe(false);
    });

    it("claude's first-run stub (an account, no mcpServers) is NOT ready", () => {
      const dir = dirFor("su-stub");
      writeFileSync(
        join(dir, ".claude.json"),
        '{"oauthAccount":{"emailAddress":"o@e.com"}}',
      );
      expect(isClaudeConfigDirLaunchReady(dir)).toBe(false);
    });

    it("a P-020 pruned real copy (mcpServers kept) IS ready — never re-materialized behind its back", () => {
      const dir = dirFor("su-pruned");
      writeFileSync(
        join(dir, ".claude.json"),
        '{"mcpServers":{"papercusp-su":{}},"hasCompletedOnboarding":true}',
      );
      expect(isClaudeConfigDirLaunchReady(dir)).toBe(true);
    });

    it("a dangling symlink / corrupt json is NOT ready, and never throws", () => {
      const dangling = dirFor("su-dangle");
      symlinkSync(join(root, "gone.json"), join(dangling, ".claude.json"));
      expect(isClaudeConfigDirLaunchReady(dangling)).toBe(false);
      const corrupt = dirFor("su-corrupt");
      writeFileSync(join(corrupt, ".claude.json"), "{ not json");
      expect(isClaudeConfigDirLaunchReady(corrupt)).toBe(false);
      expect(isClaudeConfigDirLaunchReady("")).toBe(false);
    });
  });

  describe("ensureInteractiveConfigViaOperator", () => {
    it("POSTs the owner and reports the repair when the dir is not launch-ready", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const calls: { url: string; opts: any }[] = [];
      const fetchImpl = async (url: string, opts: any) => {
        calls.push({ url, opts });
        return {
          json: async () => ({
            ok: true,
            owner: "su-remat",
            configDir: join(root, "su-remat"),
            repaired: true,
          }),
        };
      };
      const r = await ensureInteractiveConfigViaOperator(
        "su-remat",
        dirFor("su-remat"),
        {
          fetchImpl,
          operatorUrl: "http://op:1",
          token: "tok-1",
        },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        "http://op:1/api/adv/sessions/ensure-claude-config",
      );
      expect(calls[0].opts.method).toBe("POST");
      expect(calls[0].opts.headers.authorization).toBe("Bearer tok-1");
      expect(JSON.parse(calls[0].opts.body)).toEqual({ owner: "su-remat" });
      expect(r).toMatchObject({ ok: true, repaired: true });
      // The repair is DISCLOSED — a silently-degraded session is the bug.
      expect(errSpy).toHaveBeenCalledTimes(1);
      errSpy.mockRestore();
    });

    it("a healthy dir costs NO round-trip (the normal resume is byte-identical)", async () => {
      const home = mkdtempSync(join(tmpdir(), "psu-icc-home2-"));
      writeFileSync(
        join(home, ".claude.json"),
        '{"mcpServers":{"papercusp-su":{}}}',
      );
      const dir = dirFor("su-healthy");
      symlinkSync(join(home, ".claude.json"), join(dir, ".claude.json"));
      const calls: unknown[] = [];
      const fetchImpl = async (...a: unknown[]) => {
        calls.push(a);
        return { json: async () => ({ ok: true }) };
      };
      expect(
        await ensureInteractiveConfigViaOperator("su-healthy", dir, {
          fetchImpl,
          operatorUrl: "http://op:1",
          token: "t",
        }),
      ).toBeNull();
      expect(calls).toHaveLength(0);
      rmSync(home, { recursive: true, force: true });
    });

    it("a foreign/relocated configDir is left alone (the server can only key by owner)", async () => {
      const calls: unknown[] = [];
      const fetchImpl = async (...a: unknown[]) => {
        calls.push(a);
        return { json: async () => ({ ok: true }) };
      };
      const foreign = mkdtempSync(join(tmpdir(), "psu-foreign-"));
      // Not sessionClaudeConfigDir('su-x') — ensuring would materialize a DIFFERENT
      // dir while the one actually being launched stayed broken.
      expect(
        await ensureInteractiveConfigViaOperator("su-x", foreign, {
          fetchImpl,
          operatorUrl: "http://op:1",
          token: "t",
        }),
      ).toBeNull();
      expect(calls).toHaveLength(0);
      rmSync(foreign, { recursive: true, force: true });
    });

    it("no owner (untracked / pre-EI-155 session) → no request, returns null", async () => {
      const calls: unknown[] = [];
      const fetchImpl = async (...a: unknown[]) => {
        calls.push(a);
        return { json: async () => ({ ok: true }) };
      };
      expect(
        await ensureInteractiveConfigViaOperator(null, dirFor("su-none"), {
          fetchImpl,
          operatorUrl: "http://op:1",
          token: "t",
        }),
      ).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it("an older operator without the route (404 / ok:false) → null, launch proceeds exactly as today", async () => {
      const fetchImpl = async () => ({
        json: async () => ({ ok: false, error: "not found" }),
      });
      expect(
        await ensureInteractiveConfigViaOperator(
          "su-remat",
          dirFor("su-remat"),
          { fetchImpl, operatorUrl: "http://op:1", token: "t" },
        ),
      ).toBeNull();
    });

    it("an unreachable operator is swallowed — config repair NEVER blocks a resume", async () => {
      const fetchImpl = async () => {
        throw new Error("ECONNREFUSED");
      };
      await expect(
        ensureInteractiveConfigViaOperator("su-remat", dirFor("su-remat"), {
          fetchImpl,
          operatorUrl: "http://op:1",
          token: "t",
        }),
      ).resolves.toBeNull();
    });
  });
});

describe("EI-23153687450001394: Codex home repair heals a stale runtime port", () => {
  it("resolves PAPERCUSP_HONO_PORT before POSTing the Codex repair", async () => {
    // Keep the on-disk conventional home unique even when several test
    // processes start in the same millisecond on the shared workstation.
    const advSessionId = Date.now() * 1_000 + (process.pid % 1_000);
    const codexHome = join(
      homedir(),
      ".papercusp",
      "su-codex-homes",
      `session-${advSessionId}`,
    );
    mkdirSync(codexHome, { recursive: true });
    const probed: string[] = [];
    const calls: Array<{ url: string; opts: any }> = [];
    try {
      const result = await ensureCodexHomeViaOperator(
        "su-codex-stale-port",
        codexHome,
        advSessionId,
        {
          model: "gpt-5.6-sol:xhigh",
          headless: true,
          env: { PAPERCUSP_HONO_PORT: "3271" },
          probe: async (candidate: string) => {
            probed.push(candidate);
            return candidate === "http://127.0.0.1:3070/api/mcp";
          },
          onRecovery: () => {},
          fetchImpl: async (url: string, opts: any) => {
            calls.push({ url, opts });
            return { json: async () => ({ ok: true, repaired: false }) };
          },
          token: "tok-1",
        },
      );

      expect(result).toEqual({ ok: true, repaired: false });
      expect(probed).toEqual([
        "http://127.0.0.1:3271/api/mcp",
        "http://127.0.0.1:3070/api/mcp",
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        "http://127.0.0.1:3070/api/adv/sessions/ensure-codex-home",
      );
      expect(calls[0].opts.headers.authorization).toBe("Bearer tok-1");
      expect(JSON.parse(calls[0].opts.body)).toEqual({
        owner: "su-codex-stale-port",
        advSessionId,
        requireGatewayProvider: false,
        model: "gpt-5.6-sol:xhigh",
        headless: true,
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

// ── Transparent cache-proxy routing for default-account sessions ──────────────
// gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-006 / D-005. The load-bearing
// property: the cache proxy carries the SYSTEM login through verbatim, so unlike a
// gateway route it must SURVIVE the default-account credential enforcement — while a
// real gateway URL must still be stripped exactly as before.
describe("cache-proxy default-account routing (P-006)", () => {
  const GATEWAY_URL = "http://127.0.0.1:8788";
  afterEach(() => __setCacheProxyReachable(null));

  it("is OFF under vitest unless explicitly forced (pure-function determinism)", () => {
    __setCacheProxyReachable(null);
    expect(cacheProxyReachable()).toBe(false);
    expect(defaultAccountEnv().ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("adds the proxy base URL to the default-account env when reachable", () => {
    __setCacheProxyReachable(true);
    const env = defaultAccountEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe(CACHE_PROXY_URL());
    expect(env[ACCOUNT_ROUTING_MODE_ENV]).toBe("default");
  });

  it("DEGRADES to today’s behavior when the proxy is down — never blocks a launch", () => {
    __setCacheProxyReachable(false);
    expect(defaultAccountEnv()).toEqual({
      [ACCOUNT_ROUTING_MODE_ENV]: "default",
    });
  });

  it("isCacheProxyUrl matches equivalent spellings but not a gateway route", () => {
    const p = new URL(CACHE_PROXY_URL());
    expect(isCacheProxyUrl(CACHE_PROXY_URL())).toBe(true);
    expect(isCacheProxyUrl(`http://localhost:${p.port}`)).toBe(true);
    expect(isCacheProxyUrl(`http://127.0.0.1:${p.port}/`)).toBe(true);
    expect(isCacheProxyUrl(GATEWAY_URL)).toBe(false);
    expect(isCacheProxyUrl("https://api.anthropic.com")).toBe(false);
    expect(isCacheProxyUrl(undefined)).toBe(false);
    expect(isCacheProxyUrl("not a url")).toBe(false);
  });

  it("enforceDefaultClaudeAccount PRESERVES the cache proxy but still strips a gateway route", () => {
    const kept = enforceDefaultClaudeAccount("claude", {
      [ACCOUNT_ROUTING_MODE_ENV]: "default",
      ANTHROPIC_BASE_URL: CACHE_PROXY_URL(),
      ANTHROPIC_AUTH_TOKEN: "should-be-cleared",
    });
    expect(kept.ANTHROPIC_BASE_URL).toBe(CACHE_PROXY_URL());
    expect(kept.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    const stripped = enforceDefaultClaudeAccount("claude", {
      [ACCOUNT_ROUTING_MODE_ENV]: "default",
      ANTHROPIC_BASE_URL: GATEWAY_URL,
    });
    expect(stripped.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("the --settings overlay keeps the cache proxy and blanks a gateway route", () => {
    const kept = defaultClaudeAuthSettings({
      [ACCOUNT_ROUTING_MODE_ENV]: "default",
      ANTHROPIC_BASE_URL: CACHE_PROXY_URL(),
    });
    expect(kept.env.ANTHROPIC_BASE_URL).toBe(CACHE_PROXY_URL());
    expect(kept.apiKeyHelper).toBe("");

    const blanked = defaultClaudeAuthSettings({
      [ACCOUNT_ROUTING_MODE_ENV]: "default",
      ANTHROPIC_BASE_URL: GATEWAY_URL,
    });
    expect(blanked.env.ANTHROPIC_BASE_URL).toBe("");
  });

  it("an auto/pin gateway route is still carried through untouched (no regression)", () => {
    const s = defaultClaudeAuthSettings({
      [ACCOUNT_ROUTING_MODE_ENV]: "pin",
      ANTHROPIC_BASE_URL: GATEWAY_URL,
      ANTHROPIC_AUTH_TOKEN: "tok",
    });
    expect(s.env.ANTHROPIC_BASE_URL).toBe(GATEWAY_URL);
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
  });
});

describe("omp context-injection hook wiring (omp-context-injection-parity-2026-08-09 P-003)", () => {
  let home: string;
  const hookRel = [".papercusp", "hooks", "omp", "inject-hook.ts"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "psu-omp-inject-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const installHook = () => {
    mkdirSync(join(home, ".papercusp", "hooks", "omp"), { recursive: true });
    writeFileSync(join(home, ...hookRel), "export default () => {};");
    return join(home, ...hookRel);
  };

  it("resolves the installed hook for omp", () => {
    const p = installHook();
    expect(resolveOmpInjectHookPath("omp", home)).toBe(p);
  });

  it("returns undefined when the installer has not run — launch unchanged, not broken", () => {
    // A box that never ran the installer has no hook file. Passing --hook at a
    // missing path would make every omp launch fail; absent is the safe state.
    expect(resolveOmpInjectHookPath("omp", home)).toBeUndefined();
  });

  it("is omp-only: claude and codex never get --hook", () => {
    installHook();
    expect(resolveOmpInjectHookPath("claude", home)).toBeUndefined();
    expect(resolveOmpInjectHookPath("codex", home)).toBeUndefined();
  });

  it("APPENDS --hook without replacing the coord extension (both loaders coexist)", () => {
    // omp merges --hook and -e into ONE additionalExtensionPaths list, so these
    // accumulate. The regression this guards is a future edit that "simplifies"
    // by making one flag replace the other, which would silently disable either
    // lock enforcement or context injection.
    const { args } = suLaunchArgs("omp", {
      promptFile: "/p.md",
      coordExtPath: "/h/.papercusp/papercusp-coord.ts",
      injectHookPath: "/h/.papercusp/hooks/omp/inject-hook.ts",
    });
    expect(args).toContain("-e");
    expect(args).toContain("/h/.papercusp/papercusp-coord.ts");
    expect(args).toContain("--hook");
    expect(args).toContain("/h/.papercusp/hooks/omp/inject-hook.ts");
  });

  it("omits --hook entirely when no hook path is supplied", () => {
    expect(suLaunchArgs("omp", { promptFile: "/p.md" }).args).not.toContain(
      "--hook",
    );
  });

  it("threads --hook through the role and resume launch paths too", () => {
    const hookPath = "/h/.papercusp/hooks/omp/inject-hook.ts";
    expect(
      roleLaunchArgs("omp", { promptFile: "/p.md", injectHookPath: hookPath })
        .args,
    ).toContain(hookPath);
    expect(
      resumeArgsFor(
        { agent: "omp", cwd: "/x", ompThreadId: null },
        { injectHookPath: hookPath },
      ).args,
    ).toContain(hookPath);
  });

  it("stays ADDITIVE: adding the hook introduces no model or routing argument", () => {
    // Owner standing preference 2026-06-29 — psu->omp launches on OMP's own
    // default config and the owner picks the model interactively in-app. The
    // injection wiring must never become a back door for forcing a model.
    const withHook = suLaunchArgs("omp", {
      promptFile: "/p.md",
      injectHookPath: "/h/hook.ts",
    }).args;
    const without = suLaunchArgs("omp", { promptFile: "/p.md" }).args;
    expect(
      withHook.filter((a) => !["--hook", "/h/hook.ts"].includes(a)),
    ).toEqual(without);
    for (const modelFlag of ["--model", "-m", "--models"])
      expect(withHook).not.toContain(modelFlag);
  });
});

/**
 * THE launch-su → psu SEAM (retire-mug-kettle-su-only-2026-08-09 P-042 / D-067).
 *
 * `launch-su.ts` composes argv TOKENS that this file's parser must accept, and
 * the two share no code — a GUI launch crosses a process boundary as a string.
 * That is the drift risk the unit tests on either side cannot see: launch-su's
 * own suite proves it EMITS `--mode=drain`, and this proves psu ACCEPTS it and
 * resolves the posture the GUI asked for. Neither alone closes the seam.
 *
 * The failure being guarded is silent and expensive: psu rejects an unknown mode
 * by throwing before it records anything, so the terminal opens, prints one line
 * and closes — and the caller still shows a SUCCESS toast (the same shape as the
 * model/agent-pairing bug at NewSessionLauncher.tsx:467-477).
 */
describe("launch-time mode: the tokens launch-su emits are the tokens psu parses (P-042)", () => {
  it("accepts --mode=drain and resolves DRAIN, which implies AUTO", () => {
    const args = parseArgs(["--mode=drain"]);
    expect(args.mode).toBe("drain");
    // DRAIN implies AUTO — psu forces it on rather than relying on the caller
    // to pass both, which is why launch-su sends only the one flag.
    expect(effectiveAutoMode(args)).toBe(true);
  });

  it("accepts the BOOLEAN --auto and resolves AUTO with no named mode", () => {
    const args = parseArgs(["--auto"]);
    expect(args.mode).toBeNull();
    expect(effectiveAutoMode(args)).toBe(true);
  });

  it("a launch with neither flag is NOT auto — the unchanged interactive default", () => {
    const args = parseArgs([]);
    expect(args.mode).toBeNull();
    expect(effectiveAutoMode(args)).toBe(false);
  });

  /**
   * THE FALSIFIER FOR launch-su's SPECIAL CASE. If someone "simplifies" that
   * mapping to a uniform `--mode=<id>` for every launchable mode, AUTO breaks —
   * and it breaks HERE, loudly, instead of at spawn time in a terminal nobody
   * is watching. This test is the reason the special case may not be tidied away.
   */
  it("REJECTS --mode=auto — AUTO is a boolean flag, so the uniform mapping is wrong", () => {
    expect(() => parseArgs(["--mode=auto"])).toThrow(/not recognized/);
  });

  it("rejects an unknown named mode rather than launching a plain session", () => {
    expect(() => parseArgs(["--mode=definitely-not-a-mode"])).toThrow(
      /not recognized/,
    );
  });

  /**
   * Ties the two vocabularies together so ADDING a launchable mode cannot
   * silently half-land. A new id in the registry reaches the GUI picker and
   * launch-su's validator automatically (both read LAUNCHABLE_MODE_IDS) — but
   * psu's parser is a hand-maintained literal in a .mjs file that neither can
   * see. This fails the moment those disagree.
   */
  it("every registry-launchable mode is actually launchable through psu", () => {
    for (const id of LAUNCHABLE_MODE_IDS) {
      // The mapping launch-su applies: 'auto' is the boolean, everything else
      // is a named mode.
      const argv = id === "auto" ? ["--auto"] : [`--mode=${id}`];
      const args = parseArgs(argv);
      expect(effectiveAutoMode(args)).toBe(true);
      if (id !== "auto") expect(args.mode).toBe(id);
    }
  });
});

/**
 * plan codex-1m-context-window-2026-08-17 P-004 — the per-session config.toml
 * block a MODEL-LESS `psu --resume` inherits. `modelArgsFor` cannot cover that
 * path: it emits nothing when no model is named.
 */
describe("codexContextWindowConfigPatch (resume inherits the window)", () => {
  it("uses the current owner budget instead of a stale or missing launch flag", () => {
    for (const launchArgv of [undefined, ["psu", "--compaction-limit=250000"]]) {
      const resumed = resumeArgsFor(
        { agent: "codex", sessionId: "rollout", compactionLimit: 200_000, launchArgv },
        { model: "gpt-5.6-sol:xhigh" },
      );
      expect(resumed.args).toContain("model_auto_compact_token_limit=160000");
      expect(resumed.args).toContain("model_context_window=1000000");
      expect(resumed.args).toContain('model_reasoning_effort="xhigh"');
      expect(resumed.args.slice(-2)).toEqual(["resume", "rollout"]);
    }
  });

  it("keeps the native auto-compaction trigger at the recorded session cap", () => {
    const out = codexContextWindowConfigPatch(
      'model = "gpt-5.6-sol"\n',
      "gpt-5.6-sol",
      { compactionLimit: 250_000 },
    );
    expect(out).toContain("model_context_window = 1000000");
    expect(out).toContain("model_auto_compact_token_limit = 200000");
  });

  it("passes the recorded cap from both launch argv spellings into Codex resume args", () => {
    for (const launchArgv of [
      ["psu", "--compaction-limit=250000"],
      ["psu", "--compaction-limit", "250000"],
    ]) {
      const resumed = resumeArgsFor(
        { agent: "codex", sessionId: "rollout", launchArgv },
        { model: "gpt-5.6-sol" },
      );
      expect(resumed.args).toContain("model_auto_compact_token_limit=200000");
    }
  });

  it("prepends the window keys as ROOT keys, above any table", () => {
    const out = codexContextWindowConfigPatch(
      '[mcp_servers.papercusp-su]\nurl = "x"\n',
      "gpt-5.6-sol",
    );
    // TOML binds a root key written AFTER a table header to that table, so the
    // block landing first is correctness, not tidiness: emitted below the
    // [mcp_servers.papercusp-su] header these would become MCP server settings.
    expect(out.indexOf("model_context_window")).toBeLessThan(
      out.indexOf("[mcp_servers.papercusp-su]"),
    );
    expect(out).toMatch(
      /^# BEGIN PAPERCUSP_CODEX_CONTEXT_WINDOW\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n/,
    );
    expect(out).toContain(codexContextConfigToml("gpt-5.6-sol").trim());
    expect(out).toContain('url = "x"'); // pre-existing content survives
  });

  it("is idempotent — re-applying does not accumulate duplicate blocks", () => {
    const once = codexContextWindowConfigPatch(
      'model = "gpt-5.6-sol"\n',
      "gpt-5.6-sol",
    );
    const twice = codexContextWindowConfigPatch(once, "gpt-5.6-sol");
    expect(twice).toBe(once);
    expect(twice.match(/model_context_window/g)).toHaveLength(1);
  });

  it("migrates legacy unmarked root keys instead of producing invalid duplicate TOML", () => {
    const legacy = [
      "model_context_window = 1000000",
      "model_auto_compact_token_limit = 900000",
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "memories = false",
      "",
    ].join("\n");

    const out = codexContextWindowConfigPatch(legacy, "gpt-5.6-sol");
    expect(out.match(/^model_context_window\s*=/gm)).toHaveLength(1);
    expect(out.match(/^model_auto_compact_token_limit\s*=/gm)).toHaveLength(1);
    expect(out).toContain('model = "gpt-5.6-sol"');
    expect(out).toContain("[features]\nmemories = false");
  });

  it("does not rewrite same-named keys that belong to a TOML table", () => {
    const out = codexContextWindowConfigPatch(
      "[example]\nmodel_context_window = 123\nmodel_auto_compact_token_limit = 100\n",
      "gpt-5.6-sol",
    );
    expect(out).toContain(
      "[example]\nmodel_context_window = 123\nmodel_auto_compact_token_limit = 100",
    );
    expect(out.match(/model_context_window/g)).toHaveLength(2);
  });

  it("REMOVES a stale block when the home moves to a model with no extended window", () => {
    // The failure this prevents: a home switched gpt-5.6-sol -> gpt-5.5 keeps an
    // 872k declaration for a 272k model, and papercusp then seeds a soft limit
    // above the real wall.
    const withBlock = codexContextWindowConfigPatch(
      'model = "gpt-5.5"\n',
      "gpt-5.6-sol",
    );
    expect(withBlock).toContain("model_context_window");
    const moved = codexContextWindowConfigPatch(withBlock, "gpt-5.5");
    expect(moved).not.toContain("model_context_window");
    expect(moved).toContain('model = "gpt-5.5"');
  });

  it("strips the block rather than guessing when the model is unresolvable", () => {
    const withBlock = codexContextWindowConfigPatch("", "sol");
    expect(codexContextWindowConfigPatch(withBlock, null)).toBe("");
  });
});

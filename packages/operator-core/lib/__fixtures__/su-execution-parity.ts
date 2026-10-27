/**
 * P-001 census for interchangeable-su-execution-backends-2026-10-23.
 * This is a qualification INPUT. An inventoried interface is not a support claim.
 * P-017/P-018 must attach exact scenario receipts before a cell can pass.
 */
export const SU_EXEC_INVENTORY = {
  revision: 5,
  plan: 'interchangeable-su-execution-backends-2026-10-23',
  ownerItem: 'P-001',
  host: { os: 'linux', arch: 'x64', runtime: 'current-build', otherHosts: 'unqualified' },
  versions: { claude: '2.1.293', claudeSdk: '0.3.263', codex: '0.163.0' },
  sources: {
    claudeDeclarations: {
      package: '@anthropic-ai/claude-agent-sdk', file: 'sdk.d.ts',
      sha256: '59560e31f91e47ed93e7cbcaa846e3fc3c96d8dcc41ea36cda64de96c0c4edf4',
    },
    codexSchema: {
      command: 'codex app-server generate-json-schema --out <isolated-output-directory>',
      ServerRequest: 'f339be472737a0003efa25fba2e6e6c9237e621cd065b6d6995c51256e9dc1fb',
      ClientRequest: '6b10888f163f569922d42c41e94a98b4261258abc7581c14eca867c3b125dc6f',
      ServerNotification: '8e719512bc26bb3871fcf7b378b79abf912d82787609c0ad418b71f179d0883f',
    },
  },
  replicationDoc: 'agent-insights/su-execution-backend-acceptance',
  officialCodexProtocol: 'https://learn.chatgpt.com/docs/app-server',
  evidencePolicy: {
    initialState: 'unknown',
    hiddenPtyFallback: 'failed',
    missingScenario: 'unknown',
    missingNativeRequestClassification: 'unknown',
    nativeOnlyPresentationIsParity: false,
    mandatoryGapMayBeDeferred: false,
    portablePromptEvidence: 'sha256-only',
    finalRelease: 'exact-shipped-artifact',
  },
} as const;

export const SU_EXEC_COMBINATIONS = [
  { provider: 'claude', execution: 'pty', nativeVersion: SU_EXEC_INVENTORY.versions.claude },
  { provider: 'claude', execution: 'programmatic', nativeVersion: SU_EXEC_INVENTORY.versions.claude,
    sdkVersion: SU_EXEC_INVENTORY.versions.claudeSdk },
  { provider: 'codex', execution: 'pty', nativeVersion: SU_EXEC_INVENTORY.versions.codex },
  { provider: 'codex', execution: 'programmatic', nativeVersion: SU_EXEC_INVENTORY.versions.codex },
] as const;

/** Supported entry points; runtime qualification still requires their native
 * receipts. Adapter-level fork commands deliberately point to these launchers. */
export const SU_EXEC_FORK_ROUTES = [
  { provider: 'codex', execution: 'pty', support: 'supported', route: 'native_fork_source', qualification: 'unknown',
    files: ['packages/operator-core/lib/su-session-tracked-codex-fork.integration.test.ts'],
    cases: ['registers native child ancestry before success; scenario=registered',
      'registers native child ancestry before success; scenario=stale-source',
      'registers native child ancestry before success; scenario=startup-failure',
      'registers native child ancestry before success; scenario=bootstrap-failure'] },
  { provider: 'codex', execution: 'programmatic', support: 'supported', route: 'native_fork_source', qualification: 'unknown',
    files: ['packages/operator-core/lib/su-session-fork-pending.integration.test.ts',
      'packages/operator-core/lib/su-session-codex-fork.integration.test.ts'],
    cases: ['codex native fork leaves pending question, queued input and accepted wake exclusively with parent',
      'transfers complete paginated history across homes and preserves parent isolation',
      'transfers incomplete paginated history across homes and preserves parent isolation'] },
  { provider: 'claude', execution: 'pty', support: 'supported', route: '--fork-session', qualification: 'unknown',
    files: ['apps/operator/lib/psu-launcher-fork.integration.test.ts',
      'packages/operator-core/lib/su-session-fork-pending.integration.test.ts'],
    cases: ['psu --resume --fork — server-side fork identity model (real PG) > a fork mints a FRESH adv row (distinct coord identity + native id); the original is untouched',
      'claude PTY native fork preserves parent history and isolates pending consumables'] },
  { provider: 'claude', execution: 'programmatic', support: 'supported', route: 'fork_from', qualification: 'unknown',
    files: ['packages/operator-core/lib/su-session-fork-pending.integration.test.ts'],
    cases: ['claude native fork leaves pending question, queued input and accepted wake exclusively with parent',
      'claude native fork refuses changed lineage and removes unregistered history'] },
] as const;

/** Every accepted decoder mode, including controls which are intentionally retired. */
export const SU_EXEC_PTY_CONTROLS = [
  { mode: 'turn', classification: 'required', behavior: 'queue-steer-refocus' },
  { mode: 'delivery-cancel', classification: 'required', behavior: 'wake-receipts' },
  { mode: 'raw', classification: 'native-presentation', behavior: 'terminal-keys',
    boundary: 'Raw terminal bytes stay PTY-only; semantic interrupt and human control remain required.' },
  { mode: 'osc', classification: 'native-presentation', behavior: 'terminal-colour',
    boundary: 'Terminal colour escapes are presentation; session state remains observable structurally.' },
  { mode: 'reset', classification: 'required', behavior: 'cold-carry' },
  { mode: 'recycle', classification: 'required', behavior: 'cold-carry' },
  { mode: 'carry-respawn', classification: 'required', behavior: 'cold-carry' },
  { mode: 'carry-fence', classification: 'required', behavior: 'cold-carry' },
  { mode: 'compact', classification: 'retired', behavior: 'retired-compact',
    boundary: 'Reject the retired control explicitly; never deliver its JSON as an owner turn.' },
  { mode: 'shutdown', classification: 'required', behavior: 'supervision' },
  { mode: 'hooks-observe', classification: 'required', behavior: 'observability' },
  { mode: 'identity-assume', classification: 'required', behavior: 'same-provider-handoff' },
  { mode: 'mcp-reconnect', classification: 'required', behavior: 'mcp-reconnect' },
] as const;

/** Native server requests, extracted from Codex 0.163.0's generated schema. */
export const SU_EXEC_CODEX_REQUESTS = [
  'account/chatgptAuthTokens/refresh', 'applyPatchApproval', 'attestation/generate',
  'execCommandApproval', 'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'item/tool/call', 'item/tool/requestUserInput', 'mcpServer/elicitation/request',
] as const;

/** The installed SDK's entire Query control surface, not just today's engine Pick<Query>. */
export const SU_EXEC_CLAUDE_QUERY_METHODS = [
  'interrupt', 'setPermissionMode', 'setMcpPermissionModeOverride', 'setModel',
  'setMaxThinkingTokens', 'applyFlagSettings', 'updateSettings', 'initializationResult',
  'reinitialize', 'supportedCommands', 'supportedModels', 'supportedAgents',
  'mcpServerStatus', 'getContextUsage', 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET',
  'readFile', 'reloadPlugins', 'reloadSkills', 'reloadOutputStyles', 'accountInfo',
  'rewindFiles', 'seedReadState', 'reconnectMcpServer', 'toggleMcpServer',
  'setMcpServers', 'streamInput', 'stopTask', 'backgroundTasks', 'close',
] as const;

export const SU_EXEC_CLAUDE_REQUESTS = ['canUseTool', 'AskUserQuestion', 'onElicitation:form', 'onElicitation:url'] as const;

const HOST = 'packages/operator-core/lib/su-session-host.ts';
const RPC = 'packages/operator-core/lib/su-session-rpc-engine.ts';
const CLAUDE = 'packages/operator-core/lib/su-session-claude-engine.ts';
const CARDS = 'packages/operator-core/lib/su-session-native-cards.ts';
const LAUNCH = 'packages/operator-core/lib/su-session-attached-launch.ts';
const PTY = 'apps/operator/scripts/psu-pty-host.mjs';

/** Acceptance targets, not assertions that the current implementations pass. */
const CONTROL_DUTIES = {
  turn: { requirement: 'R-4', item: 'P-004',
    action: 'Queue, steer and refocus once with the addressed owner and durable command identity.',
    falsifier: 'A duplicate or stale delivery executes a second turn or reaches another owner.' },
  'delivery-cancel': { requirement: 'R-9', item: 'P-010',
    action: 'Cancel the exact delivery and settle its receipt without injecting an agent turn.',
    falsifier: 'A cancelled delivery is injected or its receipt acknowledges another generation.' },
  raw: { requirement: 'R-15', item: 'P-016',
    action: 'Keep raw keys on PTY; programmatic execution refuses raw bytes and exposes semantic interruption separately.',
    falsifier: 'Raw bytes become a programmatic owner turn, or refusing bytes removes semantic human control.' },
  osc: { requirement: 'R-15', item: 'P-016',
    action: 'Keep colour escapes on the PTY display; programmatic execution refuses terminal escapes and retains structured state.',
    falsifier: 'A display escape reaches native input or terminal colour substitutes for structured session state.' },
  reset: { requirement: 'R-10', item: 'P-011',
    action: 'Reset context at a clean boundary with durable carry and one successor generation.',
    falsifier: 'A reset erases owner obligations or races an in-flight native tool operation.' },
  recycle: { requirement: 'R-10', item: 'P-011',
    action: 'Replace the native child at a clean boundary while retaining logical identity and carry dispositions.',
    falsifier: 'Both child generations execute or the new child loses an unresolved owner obligation.' },
  'carry-respawn': { requirement: 'R-10', item: 'P-011',
    action: 'Persist deterministic carry, fence the old child and verify successor bootstrap before accepting commands.',
    falsifier: 'An unready successor consumes a wake or native process handles are treated as durable state.' },
  'carry-fence': { requirement: 'R-10', item: 'P-011',
    action: 'Fence the exact pending carry for the addressed owner and generation without injecting an agent turn.',
    falsifier: 'A foreign or stale fence cancels a successor, or a fenced carry still starts a second consumer.' },
  compact: { requirement: 'R-15', item: 'P-016',
    action: 'Return the retired-control refusal without injecting any part of the control envelope.',
    falsifier: 'The retired compact envelope is silently accepted or typed as an owner turn.' },
  shutdown: { requirement: 'R-8', item: 'P-009',
    action: 'Validate shutdown authority, settle pending state and stop only the owned native child.',
    falsifier: 'Shutdown kills a foreign child or reports completion while its owned child remains unmanaged.' },
  'hooks-observe': { requirement: 'R-14', item: 'P-015',
    action: 'Report generation-scoped hooks and lifecycle observations without creating an agent turn.',
    falsifier: 'A stale observation is accepted for another child or an unmeasured value is reported healthy.' },
  'identity-assume': { requirement: 'R-11', item: 'P-012',
    action: 'Validate the scoped identity assumption, fence the source and preserve one authoritative owner before releasing queued inputs.',
    falsifier: 'A foreign or stale assumption changes owner identity, or both generations consume commands or wakes.' },
  'mcp-reconnect': { requirement: 'R-3', item: 'P-003',
    action: 'Reconnect the scoped MCP server and verify the native tool catalog without broadening authority.',
    falsifier: 'Reconnect is reported healthy from a saved descriptor or silently falls back to a PTY process.' },
} as const;

/** Every decoder control has an explicit cell for each provider/execution pair.
 * Programmatic terminal presentation is a typed refusal, not a parity waiver.
 * Existing suites are mapped as drill targets; qualification remains unknown. */
export const SU_EXEC_CONTROL_SCENARIOS = SU_EXEC_COMBINATIONS.flatMap(combination =>
  SU_EXEC_PTY_CONTROLS.map(control => ({
    ...CONTROL_DUTIES[control.mode],
    ...combination,
    id: `pty-control:${control.mode}`,
    mode: control.mode,
    classification: control.classification,
    disposition: control.classification === 'retired' ? 'explicit-refusal'
      : control.classification === 'native-presentation'
        ? combination.execution === 'pty' ? 'terminal-presentation' : 'explicit-refusal'
        : 'semantic-equivalent',
    boundary: 'boundary' in control ? control.boundary : 'Owner-required semantics apply to both execution kinds.',
    sources: combination.execution === 'pty' ? [PTY]
      : [HOST, combination.provider === 'claude' ? CLAUDE : RPC],
    testTargets: combination.execution === 'pty'
      ? [control.mode === 'identity-assume'
        ? 'apps/operator/lib/psu-pty-host-assume-fence.test.ts'
        : 'apps/operator/lib/psu-pty-host.test.ts']
      : ['packages/operator-core/lib/su-session-host.test.ts',
        `packages/operator-core/lib/su-session-${combination.provider === 'claude' ? 'claude' : 'rpc'}-engine.test.ts`],
    liveTestTarget: 'packages/operator-core/lib/su-session-attached-live.integration.test.ts',
  })));

/** Distinct native requests must acquire distinct receipts. Authentication and
 * attestation are host controls, never ordinary question cards. A classification
 * describes the acceptance duty, not present implementation support. */
export const SU_EXEC_NATIVE_REQUESTS = [
  { provider: 'codex', method: 'account/chatgptAuthTokens/refresh', kind: 'credential',
    action: 'Refresh only the selected account through the private credential route; refuse unavailable refresh.',
    falsifier: 'Publish access tokens in a card, transcript, checkpoint or test receipt.' },
  { provider: 'codex', method: 'attestation/generate', kind: 'host-control',
    action: 'Use a supported scoped attestation provider or return an explicit native refusal.',
    falsifier: 'Invent an attestation or silently leave the native request pending.' },
  { provider: 'codex', method: 'applyPatchApproval', kind: 'permission',
    action: 'Resolve a legacy file-change approval with exact paths, native request scope and one answer.',
    falsifier: 'A duplicate, foreign-generation or cancelled approval grants file access.' },
  { provider: 'codex', method: 'execCommandApproval', kind: 'permission',
    action: 'Resolve a legacy command approval without broadening command or runtime authority.',
    falsifier: 'Map a one-command grant into a broader remembered execution policy.' },
  { provider: 'codex', method: 'item/commandExecution/requestApproval', kind: 'permission',
    action: 'Present the exact command and requested scope; settle grant, denial, cancellation and reconnect.',
    falsifier: 'An answer is accepted for another command, turn, workspace or session generation.' },
  { provider: 'codex', method: 'item/fileChange/requestApproval', kind: 'permission',
    action: 'Present the exact file-change set and scope with one explicit answer or terminal refusal.',
    falsifier: 'An expired file-change request can still authorize a later edit.' },
  { provider: 'codex', method: 'item/permissions/requestApproval', kind: 'permission',
    action: 'Preserve native permission categories and duration; deny unsupported scopes explicitly.',
    falsifier: 'A selected permission grants additional network, filesystem or lifetime authority.' },
  { provider: 'codex', method: 'item/tool/call', kind: 'tool',
    action: 'Dispatch an authorized dynamic-tool call once and correlate its structured result or error.',
    falsifier: 'Replay a tool with an uncertain outcome after a disconnect or handoff.' },
  { provider: 'codex', method: 'item/tool/requestUserInput', kind: 'question',
    action: 'Preserve multiple questions, choice identities, free text and secret-input policy.',
    falsifier: 'A secret answer reaches public event history or a choice answers the wrong question.' },
  { provider: 'codex', method: 'mcpServer/elicitation/request', kind: 'elicitation',
    action: 'Preserve form and URL elicitation semantics, native scope, decline and cancellation.',
    falsifier: 'Rewrite a URL authentication flow as plain text or accept a stale form response.' },
  { provider: 'claude', method: 'canUseTool', kind: 'permission',
    action: 'Preserve tool-use identity, exact input and native session-only permission updates.',
    falsifier: 'A single approval mutates persistent settings or approves another tool-use identity.' },
  { provider: 'claude', method: 'AskUserQuestion', kind: 'question',
    action: 'Preserve all question/choice identities, free text, multi-select, skip and cancellation.',
    falsifier: 'A skipped question is answered by default or is delivered again after cancellation.' },
  { provider: 'claude', method: 'onElicitation:form', kind: 'elicitation',
    action: 'Validate structured form answers against the native schema and retain request provenance.',
    falsifier: 'Invalid or foreign-workspace form data is returned as an accepted native result.' },
  { provider: 'claude', method: 'onElicitation:url', kind: 'elicitation',
    action: 'Keep authentication in the provider URL flow; emit only safe completion or decline metadata.',
    falsifier: 'Copy an authentication credential or URL token into a transcript or evidence artifact.' },
] as const;

export const SU_EXEC_REQUEST_SCENARIOS = SU_EXEC_NATIVE_REQUESTS.map(request => ({
  ...request,
  id: `native-request:${request.provider}:${request.method}`,
  requirement: 'R-5', item: request.kind === 'permission' ? 'P-005' : 'P-007',
  sources: request.provider === 'claude' ? [CLAUDE, CARDS] : [RPC, CARDS],
}));

/** Every SDK control is classified, including methods the current engine does
 * not yet expose. The request-family inventory and this control census are
 * separate: observing a method declaration does not prove native execution. */
export const SU_EXEC_CLAUDE_CONTROLS = SU_EXEC_CLAUDE_QUERY_METHODS.map(method => ({
  method,
  scenario: /Mcp|mcp/.test(method) ? 'mcp-reconnect'
    : /interrupt|streamInput/.test(method) ? 'queue-steer-refocus'
    : /rewind|ReadState|readFile/.test(method) ? 'assets'
    : /Task|close/.test(method) ? 'supervision' : 'observability',
  source: CLAUDE,
  qualification: 'unknown' as const,
}));

/** Scenarios include a falsifier; none is credited merely because its file already passes. */
export const SU_EXEC_SCENARIOS = [
  { id: 'baseline', requirement: 'R-1', item: 'P-001', sources: [PTY, HOST],
    action: 'Census controls, requests, provider versions and host qualification.',
    falsifier: 'Delete a required capability or add an unclassified native request.' },
  { id: 'independent-selection', requirement: 'R-2', item: 'P-002', sources: [LAUNCH, HOST],
    action: 'Persist provider and execution independently through reconnect and restart.',
    falsifier: 'Treat provider as execution kind or re-default a saved session.' },
  { id: 'bootstrap-authority', requirement: 'R-3', item: 'P-003', sources: [LAUNCH, CLAUDE, RPC],
    action: 'Compare workspace, identity, modes, account and authority across both execution kinds.',
    falsifier: 'Switching transport broadens permission or changes the owner/workspace.' },
  { id: 'queue-steer-refocus', requirement: 'R-4', item: 'P-004', sources: [HOST, CLAUDE, RPC],
    action: 'Queue, steer, interrupt and replace a running turn with durable command identities.',
    falsifier: 'Replay an uncertain tool outcome or execute a cancelled queued turn.' },
  { id: 'request-families', requirement: 'R-5', item: 'P-007', sources: [CARDS, CLAUDE, RPC],
    action: 'Exercise every native request family, scope, cancellation and secret-input policy.',
    falsifier: 'Answer a stale/foreign request, leak a secret or silently drop an unsupported family.' },
  { id: 'assets', requirement: 'R-6', item: 'P-006', sources: [HOST, CLAUDE, RPC],
    action: 'Send text, image and file references; reconnect and revoke an attachment.',
    falsifier: 'Replay revoked, moved, expired or foreign-workspace assets.' },
  { id: 'fork', requirement: 'R-7', item: 'P-008', sources: [HOST, CLAUDE, RPC],
    action: 'Fork with valid distinct native and logical identities and preserved lineage.',
    falsifier: 'Clone a pending permission, wake receipt, claim or lock into the fork.' },
  { id: 'supervision', requirement: 'R-8', item: 'P-009', sources: [PTY, HOST, LAUNCH],
    action: 'Qualify startup, readiness, exit, stop, crash, lost connection and owned cleanup.',
    falsifier: 'Report ready from a saved descriptor or leave an unmanaged child running.' },
  { id: 'wake-receipts', requirement: 'R-9', item: 'P-010', sources: [PTY, HOST],
    action: 'Consume owner, peer, timer and system deliveries once across every receipt stage.',
    falsifier: 'Relabel a peer as owner or lose/duplicate a delivery after a lost acknowledgement.' },
  { id: 'cold-carry', requirement: 'R-10', item: 'P-011', sources: [PTY, HOST, CLAUDE, RPC],
    action: 'Warm/cold carry preserves identity, work references and pending-state dispositions.',
    falsifier: 'Resume from a process handle or erase unresolved owner obligations.' },
  { id: 'same-provider-handoff', requirement: 'R-11', item: 'P-012', sources: [HOST, LAUNCH],
    action: 'PTY to programmatic and back with pending questions, permissions and wakes.',
    falsifier: 'Two generations issue work; readiness failure revives an unfenced source.' },
  { id: 'provider-transfer', requirement: 'R-12', item: 'P-013', sources: [HOST, LAUNCH],
    action: 'Transfer portable context to a valid new provider-native identity with omissions.',
    falsifier: 'Copy native grants/private IDs or let both providers drive one logical session.' },
  { id: 'fleet-obligations', requirement: 'R-13', item: 'P-014', sources: [LAUNCH, PTY],
    action: 'Preserve launch route, fleet duties, loops, timers, awaits and subscriptions.',
    falsifier: 'Cancel an owner-required obligation without supported replacement or refuse too late.' },
  { id: 'observability', requirement: 'R-14', item: 'P-015', sources: [HOST, CLAUDE, RPC],
    action: 'Compare hooks, lifecycle, context, usage, tools, errors and model observations.',
    falsifier: 'Report healthy/zero when the runtime has not measured the value.' },
  { id: 'human-control', requirement: 'R-15', item: 'P-016', sources: [HOST, CARDS, PTY],
    action: 'Keep owner questions, approvals, interruption and recovery usable on both routes.',
    falsifier: 'Classify an owner-required semantic action as optional terminal presentation.' },
  { id: 'composed-journey', requirement: 'R-16', item: 'P-018', sources: [LAUNCH, HOST, CARDS],
    action: 'Launch, attach assets, answer scoped requests, reconnect, fork, wake, carry and round-trip execution.',
    falsifier: 'A mandatory interaction has no exact maintained scenario and original-source receipt.' },
  { id: 'release', requirement: 'R-17', item: 'P-021', sources: [LAUNCH, HOST],
    action: 'Verify bounded canary and rollback on the exact promoted/deployed artifact.',
    falsifier: 'Substitute staging proof for the final shipped artifact.' },
  { id: 'documentation', requirement: 'R-18', item: 'P-019', sources: [HOST, LAUNCH],
    action: 'Publish canonical selection, handoff, recovery, sensitive-input and limitation procedures.',
    falsifier: 'Close with an unverified mandatory row or an optional gap without owner/disposition.' },
  { id: 'creation-default', requirement: 'R-19', item: 'P-003', sources: [LAUNCH, PTY],
    action: 'Default only omitted-kind new headless Claude/Codex launches; preserve explicit and saved choices.',
    falsifier: 'An invalid/empty/conflicting explicit choice falls back or a running session is converted.' },
] as const;

export type SuExecCombination = (typeof SU_EXEC_COMBINATIONS)[number];

export function suExecScenariosFor(combination: SuExecCombination) {
  return [...SU_EXEC_SCENARIOS,
    ...SU_EXEC_REQUEST_SCENARIOS.filter(scenario => scenario.provider === combination.provider),
    ...SU_EXEC_CONTROL_SCENARIOS.filter(scenario => scenario.provider === combination.provider
      && scenario.execution === combination.execution)];
}

export interface SuExecQualificationRow {
  id: string;
  provider: SuExecCombination['provider'];
  execution: SuExecCombination['execution'];
  nativeVersion: string;
  sdkVersion?: string;
  host: string;
  scenario: string;
  requirement: string;
  ownerItem: string;
  state: 'unknown' | 'passed' | 'failed';
  actualExecution?: SuExecCombination['execution'];
  evidenceRefs: string[];
  negativeControlRefs: string[];
}

/** A fresh qualification starts unknown, even when an older related suite is green. */
export function suExecQualificationPopulation(): SuExecQualificationRow[] {
  return SU_EXEC_COMBINATIONS.flatMap(combination => suExecScenariosFor(combination).map(scenario => ({
    id: `${combination.provider}/${combination.execution}/${scenario.id}`,
    provider: combination.provider, execution: combination.execution,
    nativeVersion: combination.nativeVersion,
    ...('sdkVersion' in combination ? { sdkVersion: combination.sdkVersion } : {}),
    host: 'linux/x64/current-build',
    scenario: scenario.id, requirement: scenario.requirement, ownerItem: scenario.item,
    state: 'unknown' as const, evidenceRefs: [], negativeControlRefs: [],
  })));
}

/** Release must not confuse an inventory, missing proof or PTY fallback with parity. */
export function suExecQualificationDefects(rows: readonly SuExecQualificationRow[]): string[] {
  const expected = suExecQualificationPopulation();
  const defects: string[] = [];
  const byId = new Map<string, SuExecQualificationRow[]>();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  for (const baseline of expected) {
    const matches = byId.get(baseline.id) ?? [];
    if (matches.length !== 1) { defects.push(`${baseline.id}: missing or duplicate row`); continue; }
    const row = matches[0];
    for (const key of ['provider', 'execution', 'nativeVersion', 'sdkVersion', 'host', 'scenario', 'requirement', 'ownerItem'] as const) {
      if (row[key] !== baseline[key]) defects.push(`${baseline.id}: ${key} changed`);
    }
    if (row.state !== 'passed') defects.push(`${baseline.id}: ${row.state}`);
    if (row.actualExecution !== row.execution) defects.push(`${baseline.id}: execution unproved or fallback`);
    if (!row.evidenceRefs.length || !row.negativeControlRefs.length) defects.push(`${baseline.id}: proof incomplete`);
  }
  for (const id of byId.keys()) if (!expected.some(row => row.id === id)) defects.push(`${id}: unclassified row`);
  return defects;
}

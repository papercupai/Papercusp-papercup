/** P007 renderer dispositions for the complete P001 revision-5 population.
 * These are acceptance inputs, never measured parity or native inference proof.
 * Keep private URLs and answers out of this inventory. */
export const SU_EXEC_REQUEST_BASELINE = {
  revision: 5,
  source: 'packages/operator-core/lib/__fixtures__/su-execution-parity.ts',
  sha256: '4da11ce827b4982fc31763dc69724055401227c1300ae0e683443a5d026d0f05',
} as const;

const unit = 'packages/operator-core/lib/su-session-native-cards.test.ts';
const pipe = 'packages/operator-core/lib/su-session-rpc-engine.integration.test.ts';
const claude = 'packages/operator-core/lib/su-session-claude-engine.test.ts';
const request = (provider: 'claude' | 'codex', method: string, scenario: string, layer: string,
  disposition: 'supported' | 'refused' = 'supported', reason = 'Validated native callback and correlated PUI card; cancellation never grants authority.', declaration = scenario) => ({
  provider, method, disposition, reason, owner: 'P-007', scenario, testFile: layer, declaration,
});
export const SU_EXEC_REQUEST_DISPOSITIONS = [
  ...['account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/call'].map(method => request('codex', method,
    `explicitly refuses unadvertised host request ${method} without a renderer or private payload event`, pipe, 'refused',
    method === 'account/chatgptAuthTokens/refresh'
      ? 'No host refresh capability is advertised. Selected credentials remain in the account route; request gets native -32601 without tokens.'
      : method === 'attestation/generate' ? 'No attestation provider is advertised; native -32601 refuses fabrication.'
        : 'No dynamic-tool definitions are advertised by this app-server client. Native -32601 refuses unregistered execution; MCP dispatch uses its separate installed tool route.',
    'explicitly refuses unadvertised host request %s without a renderer or private payload event')),
  request('codex', 'applyPatchApproval', 'preserves legacy applyPatchApproval scope without persistent-policy choices', unit, 'supported', undefined,
    'preserves legacy %s scope without persistent-policy choices'),
  request('codex', 'execCommandApproval', 'preserves legacy execCommandApproval scope without persistent-policy choices', unit, 'supported', undefined,
    'preserves legacy %s scope without persistent-policy choices'),
  request('codex', 'item/commandExecution/requestApproval', 'requires the matching workspace and an explicit approval before answering Codex', unit),
  request('codex', 'item/fileChange/requestApproval', 'maps the Codex answers to accept, acceptForSession and cancel (No and Esc both stop the turn)', unit),
  request('codex', 'item/permissions/requestApproval', 'grants only the requested scoped permissions on yes', unit, 'supported', undefined,
    'grants only the requested scoped permissions on %s'),
  request('codex', 'item/tool/requestUserInput', 'keeps native question descriptions, multiple choices and a custom answer', unit),
  request('codex', 'mcpServer/elicitation/request', 'round-trips typed MCP forms through real native pipes with workspace and cancellation fences', pipe),
  request('claude', 'canUseTool', 'cancels only the aborted Claude request and leaves a concurrent permission answerable', unit),
  request('claude', 'AskUserQuestion', 'accepts Claude multiple selections and custom text through validated cards', unit),
  request('claude', 'onElicitation:form', 'connects native MCP form callbacks to validated private cards and cancels them on runtime close', claude),
  request('claude', 'onElicitation:url', 'keeps claude authentication URLs private and revokes the link on settlement', unit, 'supported', undefined,
    'keeps %s authentication URLs private and revokes the link on settlement'),
] as const;

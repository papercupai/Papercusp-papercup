import { createHash } from 'node:crypto';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { signSpawnParams, verifySpawnParams } from '../../spawn-signing';

type ChatParent = NonNullable<UnifiedToolContext['chatParent']>;
const ISSUER = 'converse-parent-v1';
const CARD_ISSUER = 'converse-card-v1';
const TTL_SEC = 30 * 60;
const KEYS = new Set(['harness', 'workspace', 'run', 'chat', 'exp', 'sig']);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const digest = (bearer: string) => createHash('sha256').update(bearer).digest('hex');
const validAuthority = (value: ChatParent['authority']) => value
  && (value.kind === 'system' || value.kind === 'pi') && identifier(value.principalId)
  && value.principalId.startsWith(`${value.kind}:`) && value.principalId.length > value.kind.length + 1
  && /^[a-f0-9]{64}$/.test(value.credentialSha256);

/** Reuse the spawn signer/key/rotation policy, in a separate signed envelope.
 * Neither SU nor PI mounts acquire a spawn role or a shared child run ID. */
export async function mintConverseChatBinding(
  parent: Omit<ChatParent, 'credentialSha256'>,
  bearer: string,
): Promise<string> {
  if (!bearer || ![parent.workspaceId, parent.conversationId, parent.turnId, parent.runId].every(identifier)
    || !validAuthority(parent.authority)) {
    throw new Error('invalid-chat-parent');
  }
  const params = new URLSearchParams({
    harness: ISSUER, workspace: parent.workspaceId, run: parent.runId,
    chat: JSON.stringify([parent.conversationId, parent.turnId, digest(bearer),
      parent.authority.kind, parent.authority.principalId, parent.authority.credentialSha256]),
  });
  await signSpawnParams(params, { ttlSec: TTL_SEC });
  return params.toString();
}

/** Authenticate the containing mount FIRST. This signature binds association
 * to that mount's current credential; it grants no capabilities. */
export async function verifyConverseChatBinding(
  token: string,
  authority: { workspaceId: string; bearer: string },
): Promise<ChatParent | null> {
  if (!token || token.length > 8192 || !authority.bearer) return null;
  const params = new URLSearchParams(token);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!KEYS.has(key) || seen.has(key)) return null;
    seen.add(key);
  }
  if (seen.size !== KEYS.size || params.get('harness') !== ISSUER
    || params.get('workspace') !== authority.workspaceId || !identifier(params.get('run'))) return null;
  const exp = Number(params.get('exp'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + TTL_SEC) return null;
  if (!(await verifySpawnParams(new URL(`https://converse.invalid/?${params.toString()}`))).ok) return null;
  let payload: unknown;
  try { payload = JSON.parse(params.get('chat')!); } catch { return null; }
  if (!Array.isArray(payload) || payload.length !== 6 || !identifier(payload[0])
    || !identifier(payload[1]) || payload[2] !== digest(authority.bearer)) return null;
  const parentAuthority = { kind: payload[3], principalId: payload[4], credentialSha256: payload[5] };
  if (!validAuthority(parentAuthority)) return null;
  return { workspaceId: authority.workspaceId, conversationId: payload[0], turnId: payload[1],
    runId: params.get('run')!, credentialSha256: payload[2], authority: parentAuthority };
}

/** A child cannot know the CLI's native tool-use ID. Return this signed
 * dispatch receipt in the actual tool result; the parent binds it only to
 * the native result observer's callId. It grants no authority and carries
 * no bearer. Reuse the existing signer, expiry and rotation policy. */
export async function mintConverseCardBinding(input: {
  parent: ChatParent; dispatchCallId: string; childRunId: string; correlationId: string;
}): Promise<string> {
  const { parent, dispatchCallId, childRunId, correlationId } = input;
  if (![parent.workspaceId, parent.conversationId, parent.turnId, parent.runId,
    dispatchCallId, childRunId, correlationId].every(identifier)
    || !/^[a-f0-9]{64}$/.test(parent.credentialSha256) || !validAuthority(parent.authority)) {
    throw new Error('invalid-card-binding');
  }
  const params = new URLSearchParams({ harness: CARD_ISSUER, workspace: parent.workspaceId, run: parent.runId,
    chat: JSON.stringify([parent.conversationId, parent.turnId, parent.credentialSha256,
      parent.authority.kind, parent.authority.principalId, parent.authority.credentialSha256,
      dispatchCallId, childRunId, correlationId]) });
  await signSpawnParams(params, { ttlSec: TTL_SEC });
  return params.toString();
}

export async function verifyConverseCardBinding(token: string, expected: {
  parent: Omit<ChatParent, 'credentialSha256'>; childBearer: string;
}): Promise<{ dispatchCallId: string; childRunId: string; credentialSha256: string; correlationId: string } | null> {
  const { parent, childBearer } = expected;
  if (!token || token.length > 8192 || !childBearer) return null;
  const params = new URLSearchParams(token);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!KEYS.has(key) || seen.has(key)) return null;
    seen.add(key);
  }
  const exp = Number(params.get('exp'));
  const now = Math.floor(Date.now() / 1000);
  if (seen.size !== KEYS.size || params.get('harness') !== CARD_ISSUER
    || params.get('workspace') !== parent.workspaceId || params.get('run') !== parent.runId
    || !Number.isSafeInteger(exp) || exp <= now || exp > now + TTL_SEC
    || !(await verifySpawnParams(new URL(`https://converse.invalid/?${params.toString()}`))).ok) return null;
  let payload: unknown;
  try { payload = JSON.parse(params.get('chat')!); } catch { return null; }
  if (!Array.isArray(payload) || payload.length !== 9
    || payload[0] !== parent.conversationId || payload[1] !== parent.turnId
    || payload[2] !== digest(childBearer) || payload[3] !== parent.authority.kind
    || payload[4] !== parent.authority.principalId || payload[5] !== parent.authority.credentialSha256
    || ![payload[6], payload[7], payload[8]].every(identifier)) return null;
  return { dispatchCallId: payload[6], childRunId: payload[7], credentialSha256: payload[2], correlationId: payload[8] };
}

/** Native backends expose text content arrays (Claude), full MCP results
 * (Codex), or JSON text (OMP). Read only these documented wrappers; never
 * scan arbitrary model text or use a tool name/argument/order to pair calls. */
export function readConverseCardBinding(output: string): string | null {
  if (output.length > 65536) throw new Error('invalid-card-binding-output');
  const bindings: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5) throw new Error('invalid-card-binding-output');
    if (typeof value === 'string') {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return; }
      visit(parsed, depth + 1);
    } else if (Array.isArray(value)) {
      if (value.length > 32) throw new Error('invalid-card-binding-output');
      for (const block of value) visit(block, depth + 1);
    } else if (value && typeof value === 'object') {
      if ('converseCardBinding' in value) {
        if (typeof value.converseCardBinding !== 'string' || !value.converseCardBinding) {
          throw new Error('invalid-card-binding-output');
        }
        bindings.push(value.converseCardBinding);
      } else if ('content' in value) visit(value.content, depth + 1);
      else if ('type' in value && value.type === 'text' && 'text' in value) visit(value.text, depth + 1);
    }
  };
  visit(output, 0);
  if (bindings.length > 1) throw new Error('ambiguous-card-binding-output');
  return bindings[0] ?? null;
}

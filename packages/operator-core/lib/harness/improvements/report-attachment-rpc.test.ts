import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { signAuthorityRpc } from '../../authority/authority-rpc-envelope';
import { handleAuthorityRpc, type AuthorityRpcEnvelope } from '../../authority/authority-op-registry';
import { buildReportAttachmentRpcHandler, REPORT_ATTACHMENT_RPC_KIND, type ReportAttachmentRpcDeps } from './report-attachment-rpc';

const keys = generateKeyPairSync('ed25519');
const pubkey = (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
const bytes = Buffer.from('consented log');
const payload = { workItemId: 'EI-123', attachmentId: 'ba679b50-a43c-4c77-8197-65d8e3b28e63',
  kind: 'log', mime: 'text/plain', contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
const now = Date.now();
async function envelope(over: Partial<AuthorityRpcEnvelope> = {}) {
  const env = { harnessSlug: 'papercusp', kind: REPORT_ATTACHMENT_RPC_KIND, payload, ...over };
  return { ...env, auth: await signAuthorityRpc({ ...env, device_pubkey: pubkey }, async b => sign(null, b, keys.privateKey), { nowMs: now }) };
}
function setup(over: Partial<ReportAttachmentRpcDeps> = {}) {
  const putAttachment = vi.fn(async () => ({ ok: true as const, id: 'stored', deduplicated: false, byteSize: bytes.length, redaction: 'redacted' as const }));
  const deps = { workspaceId: 'receiver-workspace', nowMs: () => now,
    isCurrentMember: vi.fn(async () => true), ownsRetainedReport: vi.fn(async () => true), putAttachment, ...over };
  const handler = buildReportAttachmentRpcHandler(deps);
  const dispatch = (env: AuthorityRpcEnvelope) => handleAuthorityRpc(env, {
    handlers: { [REPORT_ATTACHMENT_RPC_KIND]: handler }, authorityExemptKinds: new Set([REPORT_ATTACHMENT_RPC_KIND]),
    verifyIsAuthority: () => false,
    // Deliberately omit the generic verifier, as legacy signed-flag OFF does.
  });
  return { deps, putAttachment, dispatch };
}
describe('consented attachment RPC boundary', () => {
  it('stores verified bytes in the receiver workspace over the existing dispatch', async () => {
    const { deps, putAttachment, dispatch } = setup();
    expect(await dispatch(await envelope())).toMatchObject({ ok: true, result: { ok: true, id: 'stored', sha256: payload.sha256 } });
    expect(deps.isCurrentMember).toHaveBeenCalledWith(pubkey);
    expect(deps.ownsRetainedReport).toHaveBeenCalledWith(pubkey, payload.workItemId);
    expect(putAttachment).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'receiver-workspace', content: bytes, door: 'federation', externalId: `${pubkey}:${payload.attachmentId}` }));
  });
  it('refuses unsigned and tampered envelopes even when generic auth is disabled', async () => {
    const { putAttachment, dispatch } = setup();
    const signed = await envelope();
    expect(await dispatch({ ...signed, auth: undefined })).toMatchObject({ result: { reason: 'unauthenticated' } });
    expect(await dispatch({ ...signed, payload: { ...payload, workItemId: 'EI-other' } })).toMatchObject({ result: { reason: 'unauthenticated' } });
    expect(putAttachment).not.toHaveBeenCalled();
  });
  it('refuses stale signatures', async () => {
    const { putAttachment, dispatch } = setup({ nowMs: () => now + 180_000 });
    expect(await dispatch(await envelope())).toMatchObject({ result: { reason: 'unauthenticated' } });
    expect(putAttachment).not.toHaveBeenCalled();
  });
  it('acknowledges the redacted byte hash rather than the incoming secret bytes', async () => {
    const { putAttachment, dispatch } = setup();
    const secretBytes = Buffer.from('Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456');
    const secretPayload = { ...payload, contentBase64: secretBytes.toString('base64'), sha256: createHash('sha256').update(secretBytes).digest('hex') };
    const result = await dispatch(await envelope({ payload: secretPayload }));
    expect(result).toMatchObject({ ok: true, result: { ok: true } });
    expect((result.result as { sha256: string }).sha256).not.toBe(secretPayload.sha256);
    expect(putAttachment).toHaveBeenCalledTimes(1);
  });
  it.each([false, 'unreadable'])('refuses nonmember/revoked/unreadable membership: %s', async verdict => {
    const { putAttachment, dispatch } = setup({ isCurrentMember: async () => { if (verdict === 'unreadable') throw Error('PG unavailable'); return false; } });
    expect(await dispatch(await envelope())).toMatchObject({ result: { reason: 'not-member' } });
    expect(putAttachment).not.toHaveBeenCalled();
  });
  it('refuses another author, missing projection, expired retention or unreadable report', async () => {
    for (const ownsRetainedReport of [async () => false, async () => { throw Error('PG unavailable'); }]) {
      const { putAttachment, dispatch } = setup({ ownsRetainedReport });
      expect(await dispatch(await envelope())).toMatchObject({ result: { reason: 'report-unavailable' } });
      expect(putAttachment).not.toHaveBeenCalled();
    }
  });
  it('refuses caller workspace, invalid base64 and incorrect byte hashes', async () => {
    const { putAttachment, dispatch } = setup();
    for (const extra of [{ workspaceId: 'other' }, { contentBase64: payload.contentBase64 + '\n' }, { sha256: '0'.repeat(64) }]) {
      expect(await dispatch(await envelope({ payload: { ...payload, ...extra } }))).toMatchObject({ result: { reason: 'invalid' } });
    }
    expect(putAttachment).not.toHaveBeenCalled();
  });
});

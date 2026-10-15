import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { sendMailDraft } from './mail';
import { allowAllMailboxProbe } from './deliverability';
import { mailProviderFixture, type MailProviderCall } from './__fixtures__/mail-provider';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';

function source(id: string, account: string, status = 'connected') {
  return {
    id,
    workspaceId: WORKSPACE,
    kind: 'gmail',
    ownerUserId: USER,
    providerAccountId: account,
    credentialRef: `credential:${account}`,
    status,
    config: {},
    cursor: {},
    lastError: null,
    lastConnectedAt: null,
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

/**
 * `vaultRows` drives classifyAddressee: an address present in a document's TEXT
 * and absent from every participants[] is `body-only` — the injected-addressee
 * signature the D-020 rail refuses.
 */
function fakeSql(options: {
  vaultRows?: Array<{ asContact: boolean; asParticipant: boolean; inBody: boolean }>;
}) {
  const query = async (parts: TemplateStringsArray) => {
    const text = parts.join(' ');
    if (text.includes('FROM harness_shared.documents')) {
      return options.vaultRows ?? [{ asContact: false, asParticipant: false, inBody: false }];
    }
    if (text.includes('FROM harness_shared.data_sources')) return [source('s1', 'avi@example.com')];
    return [];
  };
  return query as unknown as postgres.Sql;
}

interface LiveDraft {
  to: string[];
  cc: string[];
  subject: string | null;
}

const REVIEWED: LiveDraft = { to: ['hiring@company.example'], cc: [], subject: 'Senior Engineer' };

/**
 * A provider holding one draft whose live recipients are `live`: `mail.draft`
 * read returns them, `mail.send` draft sends it.
 */
async function deps(live: LiveDraft = REVIEWED) {
  const fixture = await mailProviderFixture(({ capability, args }) =>
    capability === 'mail.draft'
      ? { draftId: args.draftId, ...live }
      : { messageId: 'message-1', threadId: 'thread-1' },
  );
  return {
    // Draft-send semantics, not deliverability, are this file's subject — but
    // the rail runs on every send, so it needs a probe or it would do live DNS.
    deps: { ...fixture.deps, probeMailbox: allowAllMailboxProbe },
    calls: fixture.calls,
  };
}

const sends = (calls: readonly MailProviderCall[]) => calls.filter((call) => call.capability === 'mail.send');

const BASE = {
  workspaceId: WORKSPACE,
  userId: USER,
  agentOwnerId: null,
  draftId: 'draft-1',
  provenance: { from: 'owner-instruction' } as const,
};

describe('sendMailDraft', () => {
  it('sends the draft by id when the live recipients match what the caller declared', async () => {
    const { deps: d, calls } = await deps();

    const result = await sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d);

    // Read the live draft first, then send it by id.
    expect(calls.map((call) => [call.capability, call.args])).toEqual([
      ['mail.draft', { operation: 'read', draftId: 'draft-1' }],
      ['mail.send', { operation: 'draft', draftId: 'draft-1' }],
    ]);
    expect(result.mode).toBe('send');
    expect(result.messageId).toBe('message-1');
    expect(result.draftId).toBe('draft-1');
    // Echoes what SHIPPED, read from the provider — not what the caller hoped.
    expect(result.sentTo).toEqual(['hiring@company.example']);
    expect(result.subject).toBe('Senior Engineer');
  });

  it('REFUSES — and does not send — when the draft was re-addressed under the caller', async () => {
    // The property this verb exists for. Sending by draft id ships what the
    // provider holds, so a draft edited between review and send would otherwise
    // go to an address nobody approved, irreversibly.
    const { deps: d, calls } = await deps({ to: ['someone-else@elsewhere.example'], cc: [], subject: 'Senior Engineer' });

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d),
    ).rejects.toThrow(/mail_send_draft_recipients_changed/);

    expect(sends(calls)).toHaveLength(0);
  });

  it('names BOTH sides in the mismatch so the caller can adjudicate it', async () => {
    // "They differ" is not actionable; deciding whether the draft was
    // legitimately edited or tampered with requires seeing both sets.
    const { deps: d } = await deps({ to: ['someone-else@elsewhere.example'], cc: [], subject: null });

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d),
    ).rejects.toThrow(/expected=hiring@company\.example.*actual=someone-else@elsewhere\.example/);
  });

  it('re-runs the D-020 rail against the LIVE recipients, not the declared ones', async () => {
    // The clearance done at DRAFT time judged bytes that may no longer exist.
    // Here the live address carries the injected signature; the caller declared
    // that same address, so the MATCH passes and only the rail can catch it.
    const { deps: d, calls } = await deps({ to: ['injected@attacker.example'], cc: [], subject: null });

    await expect(
      sendMailDraft(
        fakeSql({ vaultRows: [{ asContact: false, asParticipant: false, inBody: true }] }),
        { ...BASE, expectedTo: ['injected@attacker.example'] },
        d,
      ),
    ).rejects.toThrow();

    expect(sends(calls)).toHaveLength(0);
  });

  it('reports the RAIL failure, not the mismatch, when a draft is re-addressed to a hostile recipient', async () => {
    // Both checks fail here. The security-relevant one is the informative one.
    const { deps: d, calls } = await deps({ to: ['injected@attacker.example'], cc: [], subject: null });

    await expect(
      sendMailDraft(
        fakeSql({ vaultRows: [{ asContact: false, asParticipant: false, inBody: true }] }),
        { ...BASE, expectedTo: ['hiring@company.example'] },
        d,
      ),
    ).rejects.toThrow(/^(?!.*mail_send_draft_recipients_changed).*$/s);

    expect(sends(calls)).toHaveLength(0);
  });

  it('refuses a draft addressed to nobody rather than letting the provider decide', async () => {
    const { deps: d, calls } = await deps({ to: [], cc: [], subject: null });

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d),
    ).rejects.toThrow('mail_send_draft_no_recipients');

    expect(sends(calls)).toHaveLength(0);
  });

  it('matches recipients order- and case-insensitively', async () => {
    const { deps: d, calls } = await deps({ to: ['b@example.com', 'a@example.com'], cc: [], subject: null });

    await sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['A@Example.com', ' b@example.com '] }, d);

    expect(sends(calls)).toHaveLength(1);
  });

  it('REFUSES when the cc list changed even though the To list matches', async () => {
    // A silently-added cc is an unapproved recipient exactly like a changed to.
    const { deps: d, calls } = await deps({
      to: ['hiring@company.example'],
      cc: ['watcher@elsewhere.example'],
      subject: null,
    });

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d),
    ).rejects.toThrow(/mail_send_draft_recipients_changed/);

    expect(sends(calls)).toHaveLength(0);
  });

  it('REFUSES when the draft dropped a recipient the caller expected', async () => {
    const { deps: d, calls } = await deps({ to: ['hiring@company.example'], cc: [], subject: null });

    await expect(
      sendMailDraft(
        fakeSql({}),
        { ...BASE, expectedTo: ['hiring@company.example', 'second@company.example'] },
        d,
      ),
    ).rejects.toThrow(/mail_send_draft_recipients_changed/);

    expect(sends(calls)).toHaveLength(0);
  });

  it('requires a draft id and a declared addressee', async () => {
    const { deps: d, calls } = await deps();

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, draftId: '  ', expectedTo: ['a@b.example'] }, d),
    ).rejects.toThrow('mail_send_draft_id_required');

    await expect(sendMailDraft(fakeSql({}), { ...BASE, expectedTo: [] }, d)).rejects.toThrow(
      'mail_send_draft_expected_to_required',
    );

    // Neither the read nor the send may be attempted on a malformed request.
    expect(calls).toHaveLength(0);
  });

  it('never re-encodes: the send carries only the draft id', async () => {
    // The whole point of sending BY DRAFT ID is that the reviewed bytes ship.
    // If this verb ever passed a subject/text/recipients it would be composing a
    // new message, and the artifact the human approved would no longer be the
    // artifact sent.
    const { deps: d, calls } = await deps();

    await sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d);

    expect(sends(calls).map((call) => call.args)).toEqual([{ operation: 'draft', draftId: 'draft-1' }]);
  });
});

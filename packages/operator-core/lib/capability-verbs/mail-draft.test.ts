import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { draftNewMail, type MailDeps } from './mail';
import { allowAllMailboxProbe } from './deliverability';
import { mailProviderFixture } from './__fixtures__/mail-provider';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';

/**
 * These fixtures exercise the shape that create-shaped outbound could not take
 * before: no stored document, so no account to inherit and no thread to join.
 */
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
 * `vaultRows` drives classifyAddressee. An address is `body-only` when it is
 * present in a document's TEXT and absent from every participants[] — the
 * injected-addressee signature the rail exists to refuse.
 */
function fakeSql(options: {
  sources: ReturnType<typeof source>[];
  vaultRows?: Array<{ asContact: boolean; asParticipant: boolean; inBody: boolean }>;
}) {
  const query = async (parts: TemplateStringsArray) => {
    const text = parts.join(' ');
    if (text.includes('FROM harness_shared.documents')) {
      return options.vaultRows ?? [{ asContact: false, asParticipant: false, inBody: false }];
    }
    if (text.includes('FROM harness_shared.data_sources')) return options.sources;
    return [];
  };
  return query as unknown as postgres.Sql;
}

/** A recording Gmail provider. Drafting, not deliverability, is this file's subject. */
async function provider(overrides: Partial<MailDeps> = {}) {
  const fixture = await mailProviderFixture();
  // The deliverability rail runs on every outbound verb, so it needs a probe or
  // it would do live DNS.
  return { deps: { ...fixture.deps, probeMailbox: allowAllMailboxProbe, ...overrides }, calls: fixture.calls };
}

type ProviderAttachment = { filename: string; contentType: string; contentBase64: string };

describe('draftNewMail', () => {
  it('creates a draft with no threadId and returns the draft id', async () => {
    const { deps, calls } = await provider();
    const sql = fakeSql({ sources: [source('s1', 'only@example.com')] });

    const result = await draftNewMail(
      sql,
      {
        workspaceId: WORKSPACE,
        userId: USER,
        to: ['hiring@company.example'],
        subject: 'Senior Engineer',
        text: 'Hello.',
        provenance: { from: 'owner-instruction' },
      },
      deps,
    );

    expect(result.mode).toBe('draft');
    expect(result.draftId).toBe('draft-1');
    expect(result.recipients.map((r) => r.address)).toEqual(['hiring@company.example']);
    // Create-shaped: the provider is handed no thread, so it mints one.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ capability: 'mail.draft', args: { operation: 'create' } });
    expect(calls[0].args.threadId ?? null).toBeNull();
  });

  it('refuses a body-only addressee exactly as the send path does', async () => {
    const { deps, calls } = await provider();
    const sql = fakeSql({
      sources: [source('s1', 'only@example.com')],
      vaultRows: [{ asContact: false, asParticipant: false, inBody: true }],
    });

    await expect(
      draftNewMail(
        sql,
        {
          workspaceId: WORKSPACE,
          userId: USER,
          to: ['injected@attacker.example'],
          subject: 'Subject',
          text: 'Body',
          provenance: { from: 'owner-instruction' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'addressee_body_only' });
    // A refused addressee must never reach the provider, draft or not.
    expect(calls).toHaveLength(0);
  });

  it('refuses ambiguously when several accounts are connected, and names them', async () => {
    const { deps } = await provider();
    const sql = fakeSql({
      sources: [source('s1', 'personal@example.com', 'connecting'), source('s2', 'work@example.com')],
    });

    await expect(
      draftNewMail(
        sql,
        {
          workspaceId: WORKSPACE,
          userId: USER,
          to: ['hiring@company.example'],
          subject: 'Subject',
          text: 'Body',
          provenance: { from: 'owner-instruction' },
        },
        deps,
      ),
    ).rejects.toThrow(/outbound_source_ambiguous:email-message.*gmail:personal@example\.com.*gmail:work@example\.com/);
  });

  it('selects the account named by `from`, including one still backfilling', async () => {
    const { deps, calls } = await provider();
    const sql = fakeSql({
      sources: [source('s1', 'personal@example.com', 'connecting'), source('s2', 'work@example.com')],
    });

    const result = await draftNewMail(
      sql,
      {
        workspaceId: WORKSPACE,
        userId: USER,
        to: ['hiring@company.example'],
        subject: 'Subject',
        text: 'Body',
        provenance: { from: 'owner-instruction' },
        from: 'Personal@Example.com',
      },
      deps,
    );

    expect(result.draftId).toBe('draft-1');
    // Matched case-insensitively, and `connecting` is a usable account: a
    // mailbox mid-backfill can still be drafted in. The host binds the call to
    // that source, and so to its credential.
    expect(calls.map((call) => call.source)).toEqual(['s1']);
  });

  it('names the connected accounts when `from` matches none of them', async () => {
    const { deps } = await provider();
    const sql = fakeSql({ sources: [source('s1', 'work@example.com')] });

    await expect(
      draftNewMail(
        sql,
        {
          workspaceId: WORKSPACE,
          userId: USER,
          to: ['hiring@company.example'],
          subject: 'Subject',
          text: 'Body',
          provenance: { from: 'owner-instruction' },
          from: 'typo@example.com',
        },
        deps,
      ),
    ).rejects.toThrow(/outbound_source_account_not_connected:email-message:typo@example\.com.*gmail:work@example\.com/);
  });
});

/**
 * The defect these cover, measured 2026-09-16: 20 real Gmail drafts were created
 * whose composed records each DECLARED a resume PDF, while the encoder was
 * text/plain-only — so every one of them reached the owner's mailbox carrying no
 * attachment, and nothing in the mail client showed the omission. The contract is
 * therefore all-or-nothing: a declared file is carried, or the call fails loudly.
 */
describe('draftNewMail attachments', () => {
  const sqlFor = () => fakeSql({ sources: [source('s1', 'only@example.com')] });

  const base = {
    workspaceId: WORKSPACE,
    userId: USER,
    to: ['hiring@company.example'],
    subject: 'Senior Engineer',
    text: 'Hello.',
    provenance: { from: 'owner-instruction' as const },
  };

  it('hands a declared file to the provider as base64 with its basename as the filename', async () => {
    const bytes = Buffer.from('%PDF-1.7 resume bytes');
    const { deps, calls } = await provider({ readAttachment: async () => bytes });

    await draftNewMail(sqlFor(), { ...base, attachments: [{ path: '/tmp/downloads/Avraham_Weiss_SWE.pdf' }] }, deps);

    const attachments = calls[0].args.attachments as ProviderAttachment[];
    expect(attachments).toHaveLength(1);
    const [file] = attachments;
    // The recipient sees the basename, never the owner's local directory layout.
    expect(file.filename).toBe('Avraham_Weiss_SWE.pdf');
    expect(file.filename).not.toContain('/');
    expect(file.contentType).toBe('application/pdf');
    expect(Buffer.from(file.contentBase64, 'base64').equals(bytes)).toBe(true);
  });

  it('passes an empty attachment list when none are declared', async () => {
    const { deps, calls } = await provider();

    await draftNewMail(sqlFor(), base, deps);

    // Empty, so the provider's text/plain path stays byte-identical.
    expect(calls[0].args.attachments).toEqual([]);
  });

  it('fails the whole draft when a declared file cannot be read, naming it', async () => {
    const { deps, calls } = await provider({
      readAttachment: async () => {
        throw new Error('ENOENT');
      },
    });

    await expect(
      draftNewMail(sqlFor(), { ...base, attachments: [{ path: '/tmp/gone.pdf' }] }, deps),
    ).rejects.toThrow(/mail_attachment_unreadable:gone\.pdf/);

    // The point of all-or-nothing: no attachment-less draft is left behind.
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty file rather than attaching a zero-byte resume', async () => {
    const { deps, calls } = await provider({ readAttachment: async () => Buffer.alloc(0) });

    await expect(
      draftNewMail(sqlFor(), { ...base, attachments: [{ path: '/tmp/empty.pdf' }] }, deps),
    ).rejects.toThrow(/mail_attachment_empty:empty\.pdf/);
    expect(calls).toHaveLength(0);
  });

  it('falls back to octet-stream for an unknown extension instead of guessing', async () => {
    const { deps, calls } = await provider({ readAttachment: async () => Buffer.from('x') });

    await draftNewMail(sqlFor(), { ...base, attachments: [{ path: '/tmp/portfolio.sketchfile' }] }, deps);

    expect((calls[0].args.attachments as ProviderAttachment[])[0].contentType).toBe('application/octet-stream');
  });
});

/**
 * WI-10001658. Revising a draft had exactly one implementation before this —
 * delete it and create a replacement — which destroys the draft id and anything
 * the owner has typed into it since. These pin the update path, and pin that the
 * rails above apply to it unchanged rather than only to create.
 */
describe('draftNewMail revise', () => {
  const sqlFor = () => fakeSql({ sources: [source('s1', 'only@example.com')] });

  const base = {
    workspaceId: WORKSPACE,
    userId: USER,
    to: ['hiring@company.example'],
    subject: 'Senior Engineer',
    text: 'Hello.',
    provenance: { from: 'owner-instruction' as const },
  };

  const operations = (calls: readonly { args: Record<string, unknown> }[]) => calls.map((call) => call.args.operation);

  it('updates the named draft and never creates a second one', async () => {
    const { deps, calls } = await provider();

    const result = await draftNewMail(sqlFor(), { ...base, draftId: 'draft-77' }, deps);

    expect(operations(calls)).toEqual(['update']);
    expect(calls[0].args.draftId).toBe('draft-77');
    // The id SURVIVES the revise — that is the whole point over delete+recreate.
    expect(result.draftId).toBe('draft-77');
  });

  it('still creates when no draftId is given', async () => {
    // Control: without this, a branch inverted to always-update would pass every
    // other test in this block while silently breaking create for all callers.
    const { deps, calls } = await provider();

    await draftNewMail(sqlFor(), base, deps);

    expect(operations(calls)).toEqual(['create']);
    expect('draftId' in calls[0].args).toBe(false);
  });

  it('treats a blank draftId as create rather than updating an empty id', async () => {
    const { deps, calls } = await provider();

    await draftNewMail(sqlFor(), { ...base, draftId: '   ' }, deps);

    expect(operations(calls)).toEqual(['create']);
  });

  it('carries attachments through the revise path', async () => {
    // The defect this closes: 20 job applications sat in the owner's mailbox
    // DECLARING a resume that the text/plain-only encoder had dropped. A revise
    // that silently lost the file again would reproduce it exactly.
    const bytes = Buffer.from('%PDF-1.7 resume bytes');
    const { deps, calls } = await provider({ readAttachment: async () => bytes });

    await draftNewMail(
      sqlFor(),
      { ...base, draftId: 'draft-77', attachments: [{ path: '/tmp/downloads/Avraham_Weiss_SWE.pdf' }] },
      deps,
    );

    expect(operations(calls)).toEqual(['update']);
    const attachments = calls[0].args.attachments as ProviderAttachment[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('Avraham_Weiss_SWE.pdf');
    expect(Buffer.from(attachments[0].contentBase64, 'base64').equals(bytes)).toBe(true);
  });

  it('refuses a body-only addressee on the revise path too', async () => {
    const { deps, calls } = await provider();
    const sql = fakeSql({
      sources: [source('s1', 'only@example.com')],
      vaultRows: [{ asContact: false, asParticipant: false, inBody: true }],
    });

    await expect(
      draftNewMail(sql, { ...base, to: ['injected@attacker.example'], draftId: 'draft-77' }, deps),
    ).rejects.toMatchObject({ code: 'addressee_body_only' });
    // Revising an EXISTING draft is still outbound: the rail is not create-only.
    expect(calls).toHaveLength(0);
  });
});

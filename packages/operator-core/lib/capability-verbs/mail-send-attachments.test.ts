import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { sendNewMail, type MailDeps } from './mail';
import { allowAllMailboxProbe } from './deliverability';
import { mailProviderFixture } from './__fixtures__/mail-provider';

/**
 * WI-10001671: `sendNewMail` could not attach a file until this change, while
 * `draftNewMail` could, even though both ended in the same MIME encoder. The
 * gap was one parameter, and it read to a caller as a missing capability rather
 * than a withheld one.
 *
 * The ordering assertion below is the point of this file. Attachments are read
 * BEFORE the addressee rail and before the source is resolved, so an unreadable
 * path fails while the message is still un-sent. Read them later and the failure
 * mode inverts: recipients cleared, provider invoked, and a send either goes out
 * without the file or fails half-committed.
 */

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';
const PDF = Buffer.from('%PDF-1.7 fake resume bytes');

function source(id: string, account: string) {
  return {
    id,
    workspaceId: WORKSPACE,
    kind: 'gmail',
    ownerUserId: USER,
    providerAccountId: account,
    credentialRef: `credential:${account}`,
    status: 'connected',
    config: {},
    cursor: {},
    lastError: null,
    lastConnectedAt: null,
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

/**
 * The default documents row is a clean address (not body-only), so these tests
 * exercise attachment handling rather than re-testing the addressee rail.
 */
function fakeSql(order?: string[]) {
  const query = async (parts: TemplateStringsArray) => {
    const text = parts.join(' ');
    if (text.includes('FROM harness_shared.documents')) {
      return [{ asContact: false, asParticipant: false, inBody: false }];
    }
    if (text.includes('FROM harness_shared.data_sources')) {
      order?.push('source');
      return [source('s1', 'only@example.com')];
    }
    return [];
  };
  return query as unknown as postgres.Sql;
}

const BASE = {
  workspaceId: WORKSPACE,
  userId: USER,
  agentOwnerId: null,
  to: ['hiring@company.example'],
  subject: 'Senior Engineer',
  text: 'Hello.',
  provenance: { from: 'owner-instruction' as const },
};

async function deps(overrides: Partial<MailDeps> = {}) {
  const fixture = await mailProviderFixture();
  return {
    calls: fixture.calls,
    deps: {
      ...fixture.deps,
      readAttachment: vi.fn(async () => PDF),
      // Attachments, not deliverability, are this file's subject — but the rail
      // runs on every send, so it needs a probe or it would do live DNS.
      probeMailbox: allowAllMailboxProbe,
      ...overrides,
    } satisfies MailDeps,
  };
}

describe('sendNewMail attachments', () => {
  it('passes a declared attachment to the provider with its basename, type and bytes', async () => {
    const { deps: d, calls } = await deps();

    await sendNewMail(fakeSql(), { ...BASE, attachments: [{ path: '/fixtures/resume/Avraham_Weiss_SWE.pdf' }] }, d);

    expect(calls).toHaveLength(1);
    expect(calls[0].capability).toBe('mail.send');
    expect(calls[0].args.attachments).toEqual([
      {
        filename: 'Avraham_Weiss_SWE.pdf',
        contentType: 'application/pdf',
        contentBase64: PDF.toString('base64'),
      },
    ]);
  });

  it('passes an empty attachment list when none are declared', async () => {
    const { deps: d, calls } = await deps();

    await sendNewMail(fakeSql(), { ...BASE }, d);

    // Empty, so the provider encodes a body-only message exactly as before
    // this parameter existed.
    expect(calls[0].args.attachments).toEqual([]);
  });

  it('sends NOTHING when a declared attachment cannot be read', async () => {
    const { deps: d, calls } = await deps({
      readAttachment: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    });

    await expect(
      sendNewMail(fakeSql(), { ...BASE, attachments: [{ path: '/gone/resume.pdf' }] }, d),
    ).rejects.toThrow('mail_attachment_unreadable:resume.pdf');

    // The whole point: the failure happens before anything leaves. A send that
    // went out without the file would be strictly worse than this throw.
    expect(calls).toHaveLength(0);
  });

  it('sends NOTHING when a declared attachment is empty', async () => {
    const { deps: d, calls } = await deps({ readAttachment: vi.fn(async () => Buffer.alloc(0)) });

    await expect(
      sendNewMail(fakeSql(), { ...BASE, attachments: [{ path: '/tmp/empty.pdf' }] }, d),
    ).rejects.toThrow('mail_attachment_empty:empty.pdf');

    expect(calls).toHaveLength(0);
  });

  it('reads attachments before resolving the source, so a bad path cannot half-commit a send', async () => {
    const order: string[] = [];
    const { deps: d } = await deps({
      readAttachment: vi.fn(async () => {
        order.push('read');
        throw new Error('ENOENT');
      }),
    });

    await expect(
      sendNewMail(fakeSql(order), { ...BASE, attachments: [{ path: '/gone/resume.pdf' }] }, d),
    ).rejects.toThrow(/mail_attachment_unreadable/);

    expect(order).toEqual(['read']);
  });
});

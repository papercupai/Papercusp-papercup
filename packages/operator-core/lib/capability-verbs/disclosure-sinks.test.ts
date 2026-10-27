/**
 * Reader-set labels, R-1: every outbound capability verb consults the
 * disclosure ledger BEFORE anything leaves the box (plan
 * personal-data-reader-set-labels-2026-10-01, P-004).
 *
 * For each of the ten sinks the ledger is replaced by a stub that refuses, and
 * the provider seam (send / create / post, and the credential lookup that
 * precedes it) must never run. `disclosure-ledger.integration.test.ts` proves
 * the refusal DECISION against real Postgres; this file proves every sink
 * actually asks, and asks with the audience it is about to reach.
 *
 * Each case is also run against a PERMITTING ledger first. That run must reach
 * the provider seam — otherwise "the provider was never called" could pass
 * because some earlier step failed, not because the ledger refused.
 */
import type postgres from 'postgres';
import type { HostFetch, ProviderAdapter, ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createProviderRegistry } from '../integrations/provider-registry';

const ledger = vi.hoisted(() => ({ assertDisclosurePermits: vi.fn() }));
vi.mock('../personal-vault/disclosure-ledger', async (importActual) => ({
  ...(await importActual<typeof import('../personal-vault/disclosure-ledger')>()),
  assertDisclosurePermits: ledger.assertDisclosurePermits,
}));

const resolve = vi.hoisted(() => ({ resolveCanonicalDocument: vi.fn(), resolveOutboundContext: vi.fn() }));
vi.mock('./resolve', async (importActual) => ({
  ...(await importActual<typeof import('./resolve')>()),
  resolveCanonicalDocument: resolve.resolveCanonicalDocument,
  resolveOutboundContext: resolve.resolveOutboundContext,
}));

// social:post withholds its outbound call until the owner ratifies publishing
// (papercusp-social-auto-publish, default OFF). The ledger check runs either
// way; ratify it here so the delivery control below can observe the package.
vi.mock('@papercusp/flags/server', async (importActual) => {
  const actual = await importActual<typeof import('@papercusp/flags/server')>();
  return {
    ...actual,
    getFlag: async (...args: Parameters<typeof actual.getFlag>) =>
      args[0] === 'papercusp-social-auto-publish' ? true : actual.getFlag(...args),
  };
});

// Mail and calendar select their source through provider dispatch (P-007),
// which lists the owner's connected sources. One first-party Gmail and one
// Google Calendar source, so each verb resolves exactly one target.
const sources = vi.hoisted(() => ({ listOwnedExternalTriggerSources: vi.fn() }));
vi.mock('../external-triggers/source-store', async (importActual) => ({
  ...(await importActual<typeof import('../external-triggers/source-store')>()),
  listOwnedExternalTriggerSources: sources.listOwnedExternalTriggerSources,
}));

// Rail 2 has its own suites; here every addressee is trusted so the ledger is
// the only thing standing between the verb and the provider.
vi.mock('./addressing', async (importActual) => {
  const trusted = (address: string, provenance: { from: string }) =>
    ({ address, standing: 'known-contact', provenance: provenance.from, verified: true });
  return {
    ...(await importActual<typeof import('./addressing')>()),
    assertTrustedAddressees: vi.fn(async (_sql: unknown, p: { addresses: readonly string[]; provenance: { from: string } }) =>
      p.addresses.map((address) => trusted(address, p.provenance))),
    assertTrustedAddressee: vi.fn(async (_sql: unknown, p: { address: string; provenance: { from: string } }) =>
      trusted(p.address, p.provenance)),
  };
});

import { DisclosureRefused } from '../personal-vault/disclosure-ledger';
import type { CanonicalDocument } from './resolve';
import { allowAllMailboxProbe } from './deliverability';
import { replyToCanonicalMail, sendMailDraft, sendNewMail } from './mail';
import { deleteCalendarEvent, proposeCalendarEvent, updateCalendarEvent } from './calendar';
import { postToChatChannel, replyToCanonicalChat } from './chat';
import { postToCanonicalSocialDestination, replyToCanonicalSocialPost } from './social';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';
const AGENT = 'su-sink-test-agent';
const OWNER = { from: 'owner-instruction' } as const;
const sql = (async () => []) as unknown as postgres.Sql;

function doc(source: string, kind: string, participants: string[], payload: Record<string, unknown>): CanonicalDocument {
  return {
    id: '00000000-0000-4000-8000-0000000000d0',
    source,
    kind,
    externalId: 'ext-1',
    occurredAt: '2026-10-01T00:00:00Z',
    participants,
    title: 'title',
    text: 'body',
    payload,
  };
}

function sourceRow(id: string, kind: string) {
  return {
    id,
    workspaceId: WORKSPACE,
    kind,
    ownerUserId: USER,
    providerAccountId: 'owner@example.com',
    credentialRef: 'credential:owner',
    status: 'connected',
    config: { installSlug: 'install-1' },
    cursor: {},
    lastError: null,
    lastConnectedAt: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function outboundContext() {
  return { installSlug: 'install-1', userId: USER, source: sourceRow('s1', 'gmail') };
}

type Args = Record<string, unknown>;

function recorder(descriptor: ProviderDescriptor, invoke: (request: ProviderInvokeRequest) => Promise<unknown>): ProviderAdapter {
  return { describe: () => descriptor, syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }), invoke };
}

/**
 * Every provider seam a verb can reach, as spies. Mail and calendar reach their
 * sources' registered providers (Gmail P-008, Google Calendar P-009), so those
 * seams are the providers' capabilities, split by what each one delivers.
 */
async function providers() {
  const seams = {
    probeMailbox: vi.fn(allowAllMailboxProbe),
    mailSend: vi.fn(async (args: Args) => ({ messageId: 'm1', threadId: String(args.threadId ?? 't1') })),
    mailDraftWrite: vi.fn(async (args: Args) => ({ draftId: 'd1', messageId: 'm1', threadId: String(args.threadId ?? 't1') })),
    mailDraftRead: vi.fn(async (args: Args) => ({ draftId: args.draftId, to: ['dana@draft.example'], cc: ['erin@draft.example'], subject: 'Draft' })),
    calendarWrite: vi.fn(async (_args: Args) => ({ id: 'e1', htmlLink: null, status: 'confirmed', attendees: [] })),
    chatReply: vi.fn(async (args: Args) => ({ channelId: args.channelId, threadId: args.threadId, messageTs: '1.0' })),
  };
  const registry = createProviderRegistry();
  await registry.register({
    pluginName: 'gmail',
    descriptor: { id: 'gmail', contractVersion: 1, datatypes: ['email-message'], capabilities: ['mail.draft', 'mail.send'], egressHosts: ['gmail.googleapis.com'] },
    adapter: recorder(
      { id: 'gmail', contractVersion: 1, datatypes: ['email-message'], capabilities: ['mail.draft', 'mail.send'], egressHosts: ['gmail.googleapis.com'] },
      async ({ capability, args }) => {
        if (capability === 'mail.send') return seams.mailSend(args);
        return args.operation === 'read' ? seams.mailDraftRead(args) : seams.mailDraftWrite(args);
      },
    ),
  });
  await registry.register({
    pluginName: 'google-calendar',
    descriptor: { id: 'gcal', contractVersion: 1, datatypes: ['calendar-event'], capabilities: ['calendar.write'], egressHosts: ['www.googleapis.com'] },
    adapter: recorder(
      { id: 'gcal', contractVersion: 1, datatypes: ['calendar-event'], capabilities: ['calendar.write'], egressHosts: ['www.googleapis.com'] },
      async ({ args }) => seams.calendarWrite(args),
    ),
  });
  // Chat posts through whichever installed chat package serves the source
  // (cupboard-distributable-integrations-2026-10-10 P-008): here a Slack one.
  const slack: ProviderDescriptor = { id: 'slack', contractVersion: 1, datatypes: ['chat-message'], capabilities: ['chat.channels', 'chat.reply'], egressHosts: ['slack.com'] };
  await registry.register({ pluginName: 'slack', descriptor: slack, adapter: recorder(slack, async ({ args }) => seams.chatReply(args)) });
  // Social writes go through the installed package for the post's platform
  // (provider-adapters-to-packages-2026-10-11 P-002): one per platform here.
  const socialWrite = vi.fn(async (_args: Args) => ({ externalId: 'p1' }));
  for (const platform of ['mastodon', 'reddit']) {
    const social: ProviderDescriptor = { id: platform, contractVersion: 1, datatypes: ['social-post'], capabilities: ['social.post', 'social.reply'], egressHosts: [`${platform}.example.test`],
      // provider-registry refuses an unverified social provider before the ledger (4d002089d5);
      // same verified shape as social-provider.fixture.ts installSocialPackages.
      verification: { verifiedAt: '2026-10-16', sources: ['https://example.test/contract'], capabilities: { 'social.post': '2026-10-16', 'social.reply': '2026-10-16' } } };
    await registry.register({ pluginName: platform, descriptor: social, adapter: recorder(social, async ({ args }) => socialWrite(args)) });
  }
  const noHttp: HostFetch = async () => {
    throw new Error('provider recorders perform no HTTP');
  };
  return { ...seams, socialWrite, registry, hostFetchFor: () => noHttp };
}
type Providers = Awaited<ReturnType<typeof providers>>;

interface SinkCase {
  verb: string;
  /** The audience the verb must hand the ledger: addresses, or null for an un-enumerable sink. */
  recipients: string[] | null;
  sink: string;
  document?: CanonicalDocument;
  run: (p: Providers) => Promise<unknown>;
  /** Seams that deliver content; none may run once the ledger refuses. */
  delivery: (p: Providers) => Mock[];
}

const CASES: SinkCase[] = [
  {
    verb: 'mail:reply',
    recipients: ['alice@inbound.example'],
    sink: 'mail:reply',
    document: doc('mail', 'message', ['alice@inbound.example'], {
      direction: 'inbound', from: 'alice@inbound.example', threadId: 't1', messageId: '<m1@inbound.example>', subject: 'Hi',
    }),
    run: (p) => replyToCanonicalMail(sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'ext-1', text: 'reply', mode: 'send', agentOwnerId: AGENT }, p as never),
    delivery: (p) => [p.mailSend, p.mailDraftWrite],
  },
  {
    verb: 'mail:send',
    recipients: ['bob@to.example', 'carol@cc.example'],
    sink: 'mail:send',
    run: (p) => sendNewMail(sql, {
      workspaceId: WORKSPACE, userId: USER, to: ['bob@to.example'], cc: ['carol@cc.example'], subject: 'Hello', text: 'body', provenance: OWNER, agentOwnerId: AGENT,
    }, p as never),
    // The deliverability probe contacts the recipient's mail host, so it is a sink too.
    delivery: (p) => [p.probeMailbox, p.mailSend],
  },
  {
    verb: 'mail:send-draft',
    // Checked against the LIVE draft recipients, not what the caller declared.
    recipients: ['dana@draft.example', 'erin@draft.example'],
    sink: 'mail:send-draft',
    run: (p) => sendMailDraft(sql, {
      workspaceId: WORKSPACE, userId: USER, draftId: 'draft-1', expectedTo: ['dana@draft.example'], expectedCc: ['erin@draft.example'], provenance: OWNER, agentOwnerId: AGENT,
    }, p as never),
    // Reading the draft's recipients precedes the check by design; sending does not.
    delivery: (p) => [p.probeMailbox, p.mailSend],
  },
  {
    verb: 'calendar:propose',
    recipients: ['frank@invite.example'],
    sink: 'calendar:propose',
    run: (p) => proposeCalendarEvent(sql, {
      workspaceId: WORKSPACE, userId: USER, summary: 'Sync', start: '2026-10-02T10:00:00Z', end: '2026-10-02T11:00:00Z',
      attendees: ['frank@invite.example'], provenance: OWNER, agentOwnerId: AGENT,
    }, p as never),
    delivery: (p) => [p.calendarWrite],
  },
  {
    verb: 'calendar:update',
    // Everyone already on the event is notified, plus the additions.
    recipients: ['gina@existing.example', 'hank@added.example'],
    sink: 'calendar:update',
    document: doc('calendar', 'calendar-event', ['gina@existing.example'], { summary: 'Sync' }),
    run: (p) => updateCalendarEvent(sql, {
      workspaceId: WORKSPACE, userId: USER, eventId: 'ext-1', attendees: ['hank@added.example'], provenance: OWNER, agentOwnerId: AGENT,
    }, p as never),
    delivery: (p) => [p.calendarWrite],
  },
  {
    verb: 'calendar:delete',
    // The cancellation reaches everyone already on the event.
    recipients: ['ida@existing.example', 'jon@existing.example'],
    sink: 'calendar:delete',
    document: doc('calendar', 'calendar-event', ['ida@existing.example', 'jon@existing.example'], { summary: 'Sync' }),
    run: (p) => deleteCalendarEvent(sql, { workspaceId: WORKSPACE, userId: USER, eventId: 'ext-1', agentOwnerId: AGENT }, p as never),
    delivery: (p) => [p.calendarWrite],
  },
  {
    verb: 'chat:reply',
    recipients: null,
    sink: 'slack:C1',
    document: { ...doc('slack', 'message', ['U1'], { channelId: 'C1', threadId: '1.0' }), datatypeId: 'chat-message', sourceId: 's3' },
    run: (p) => replyToCanonicalChat(sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'ext-1', text: 'reply', agentOwnerId: AGENT }, p as never),
    delivery: (p) => [p.chatReply],
  },
  {
    verb: 'chat:post',
    recipients: null,
    sink: 'slack:C2',
    run: (p) => postToChatChannel(sql, { workspaceId: WORKSPACE, userId: USER, channelId: 'C2', threadId: '2.0', text: 'post', provenance: OWNER, agentOwnerId: AGENT }, p as never),
    delivery: (p) => [p.chatReply],
  },
  {
    verb: 'social:reply',
    recipients: null,
    sink: 'mastodon:reply',
    document: doc('mastodon', 'social-post', ['@someone'], { statusId: '109999', instanceHost: 'mastodon.social', visibility: 'public' }),
    run: (p) => replyToCanonicalSocialPost(sql, { workspaceId: WORKSPACE, userId: USER, ref: 'mastodon:109999', text: 'reply', agentOwnerId: AGENT }, p as never),
    delivery: (p) => [p.socialWrite],
  },
  {
    verb: 'social:post',
    recipients: null,
    sink: 'reddit:r/rust',
    run: (p) => postToCanonicalSocialDestination(sql, {
      workspaceId: WORKSPACE, userId: USER, destination: 'reddit:r/rust', text: 'post', provenance: OWNER, agentOwnerId: AGENT,
    } as never, p as never),
    delivery: (p) => [p.socialWrite],
  },
];

async function arrange(c: SinkCase): Promise<Providers> {
  resolve.resolveCanonicalDocument.mockReset().mockImplementation(async () => {
    if (!c.document) throw new Error(`${c.verb} resolved a document it should not need`);
    return c.document;
  });
  resolve.resolveOutboundContext.mockReset();
  sources.listOwnedExternalTriggerSources.mockReset().mockResolvedValue([
    sourceRow('s1', 'gmail'),
    sourceRow('s2', 'gcal'),
    sourceRow('s3', 'slack'),
    sourceRow('s4', 'mastodon'),
    sourceRow('s5', 'reddit'),
  ]);
  resolve.resolveOutboundContext.mockResolvedValue(outboundContext());
  return providers();
}

beforeEach(() => {
  ledger.assertDisclosurePermits.mockReset();
});

describe('every outbound capability verb asks the disclosure ledger before delivering', () => {
  it('covers all ten sinks', () => {
    expect(CASES.map((c) => c.verb)).toEqual([
      'mail:reply', 'mail:send', 'mail:send-draft',
      'calendar:propose', 'calendar:update', 'calendar:delete',
      'chat:reply', 'chat:post',
      'social:reply', 'social:post',
    ]);
  });

  describe.each(CASES)('$verb', (c) => {
    it('passes the ledger the audience it is about to reach', async () => {
      ledger.assertDisclosurePermits.mockResolvedValue(undefined);
      const p = await arrange(c);
      await c.run(p);

      expect(ledger.assertDisclosurePermits).toHaveBeenCalledTimes(1);
      const [, args] = ledger.assertDisclosurePermits.mock.calls[0] as [unknown, { agentOwnerId: string | null; recipients: string[] | null; sink: string }];
      expect(args.agentOwnerId).toBe(AGENT);
      expect(args.sink).toBe(c.sink);
      expect(args.recipients === null ? null : [...args.recipients].sort()).toEqual(c.recipients);
      // The control: with a permitting ledger the delivery path IS reached.
      expect(c.delivery(p).some((spy) => spy.mock.calls.length > 0)).toBe(true);
    });

    it('delivers nothing when the ledger refuses', async () => {
      ledger.assertDisclosurePermits.mockRejectedValue(
        new DisclosureRefused('disclosure_reader_set_violation', 'test refusal', { violating: ['x@outside.example'] }),
      );
      const p = await arrange(c);

      await expect(c.run(p)).rejects.toBeInstanceOf(DisclosureRefused);
      for (const spy of c.delivery(p)) expect(spy).not.toHaveBeenCalled();
    });
  });
});

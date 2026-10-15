/**
 * `mail:reply { planRunId }` — the run-anchored reply that replaced the retired
 * gmail:create-draft (plan generalized-integrations-google-migration-cupboard-
 * workflows-2026-10-05, D-019.1).
 *
 * Properties under test:
 *  1. The target comes from the trigger run, never from the caller.
 *  2. A retried step returns the first reply and invokes the provider once.
 *  3. A triggered run cannot SEND while automatic sending is off, and the
 *     refusal happens before any read, write or provider call. gmail:create-draft
 *     had no send branch; this is the guard that keeps that property now that
 *     the reply verb can send.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { replyToTriggerPlanRun } from './mail';
import { mailProviderFixture } from './__fixtures__/mail-provider';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';
const SOURCE = '00000000-0000-4000-8000-000000000101';
const ACCOUNT = 'owner@example.com';
const RUN = 4242;

function source() {
  return {
    id: SOURCE,
    workspaceId: WORKSPACE,
    kind: 'gmail',
    ownerUserId: USER,
    providerAccountId: ACCOUNT,
    credentialRef: `credential:${ACCOUNT}`,
    status: 'connected',
    config: {},
    cursor: {},
    lastError: null,
    lastConnectedAt: null,
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
}

function inboundMessage() {
  return {
    id: 'doc-1',
    source: 'mail',
    sourceId: SOURCE,
    providerAccountId: ACCOUNT,
    kind: 'message',
    externalId: 'inbound-1',
    occurredAt: '2026-10-06T00:00:00.000Z',
    participants: ['Investor <investor@example.com>', ACCOUNT],
    title: 'Following up',
    text: 'Body',
    metadata: {
      direction: 'inbound',
      from: 'Investor <investor@example.com>',
      subject: 'Following up',
      threadId: 'thread-9',
      messageId: 'inbound-1',
    },
  };
}

interface TriggerRunState {
  args: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

/** A recorder over the four relations the run-anchored reply touches. */
function fakeSql(run: TriggerRunState) {
  const queries: string[] = [];
  const query = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join(' ');
    queries.push(text);
    if (text.includes('FROM harness_shared.trigger_runs')) {
      return [{ id: '00000000-0000-4000-8000-0000000000aa', args: run.args, outcome: run.outcome }];
    }
    if (text.includes('UPDATE harness_shared.trigger_runs')) {
      run.outcome = JSON.parse(String(values[0])) as Record<string, unknown>;
      return [];
    }
    if (text.includes('FROM harness_shared.documents')) return [inboundMessage()];
    if (text.includes('FROM harness_shared.data_sources')) return [source()];
    throw new Error(`unexpected_query:${text}`);
  };
  return { sql: query as unknown as postgres.Sql, queries };
}

function emailRun(): TriggerRunState {
  return {
    args: { trigger: { datatypeId: 'email-message', externalId: 'inbound-1', sourceId: SOURCE } },
    outcome: {},
  };
}

const base = { workspaceId: WORKSPACE, userId: USER, planRunId: RUN, agentOwnerId: null } as const;

describe('mail:reply { planRunId }', () => {
  it('drafts the reply to the message that launched the run and records it on the run', async () => {
    const run = emailRun();
    const { sql } = fakeSql(run);
    const { deps, calls } = await mailProviderFixture();

    const result = await replyToTriggerPlanRun(sql, { ...base, text: 'Thanks, Tuesday works.' }, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: SOURCE,
      capability: 'mail.draft',
      args: { operation: 'create', threadId: 'thread-9', inReplyTo: 'inbound-1', to: ['Investor <investor@example.com>'] },
    });
    expect(result).toMatchObject({ planRunId: RUN, created: true, alreadyCreated: false, mode: 'draft' });
    expect(run.outcome.mailReply).toMatchObject({ mode: 'draft', to: 'Investor <investor@example.com>' });
  });

  it('returns the recorded reply on a retry without invoking the provider again', async () => {
    const run = emailRun();
    const { sql } = fakeSql(run);
    const { deps, calls } = await mailProviderFixture();

    await replyToTriggerPlanRun(sql, { ...base, text: 'First attempt' }, deps);
    const retry = await replyToTriggerPlanRun(sql, { ...base, text: 'Second attempt' }, deps);

    expect(calls).toHaveLength(1);
    expect(retry).toMatchObject({ created: false, alreadyCreated: true, mode: 'draft' });
  });

  it('refuses mode:"send" while automatic sending is off, before reading or calling anything', async () => {
    const run = emailRun();
    const { sql, queries } = fakeSql(run);
    const { deps, calls } = await mailProviderFixture();

    await expect(
      replyToTriggerPlanRun(sql, { ...base, text: 'Send it', mode: 'send' }, { ...deps, runSendEnabled: async () => false }),
    ).rejects.toThrow('mail_reply_run_send_withheld');

    expect(queries).toEqual([]);
    expect(calls).toEqual([]);
    expect(run.outcome).toEqual({});
  });

  it('sends when the owner has enabled automatic sending', async () => {
    const run = emailRun();
    const { sql } = fakeSql(run);
    const { deps, calls } = await mailProviderFixture();

    const result = await replyToTriggerPlanRun(
      sql,
      { ...base, text: 'Send it', mode: 'send' },
      { ...deps, runSendEnabled: async () => true },
    );

    expect(calls.map((call) => call.capability)).toEqual(['mail.send']);
    expect(result).toMatchObject({ created: true, mode: 'send' });
  });

  it('refuses a run that an email did not start', async () => {
    const run: TriggerRunState = {
      args: { trigger: { datatypeId: 'calendar-event', externalId: 'event-1', sourceId: SOURCE } },
      outcome: {},
    };
    const { sql } = fakeSql(run);
    const { deps, calls } = await mailProviderFixture();

    await expect(replyToTriggerPlanRun(sql, { ...base, text: 'Hello' }, deps)).rejects.toThrow(
      'mail_reply_run_not_email:calendar-event',
    );
    expect(calls).toEqual([]);
  });
});

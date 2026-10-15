import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

const smtpMocks = vi.hoisted(() => ({
  resolveMx: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  createConnection: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  resolveMx: smtpMocks.resolveMx,
  resolve4: smtpMocks.resolve4,
  resolve6: smtpMocks.resolve6,
}));

vi.mock('node:net', () => ({
  default: { createConnection: smtpMocks.createConnection },
  createConnection: smtpMocks.createConnection,
}));

import {
  allowAllMailboxProbe,
  assertDeliverableAddressees,
  classifyRcptReply,
  probeMailbox,
  UndeliverableAddressee,
  verdictBlocks,
  type MailboxProbe,
  type MailboxVerdict,
} from './deliverability';

/**
 * WI-10001785. The preflight exists because our transport cannot report this
 * class of failure at all: the Gmail API returns `{ threadId, messageId }` for
 * "accepted for relay", and the bounce arrives minutes later as a separate
 * inbound email. There is no error path on `mail:send` where a dead mailbox
 * could surface, so a send to a known-dead address succeeds and is reported as
 * success.
 *
 * The whole safety of this rail is one asymmetry, and it is what this file
 * exists to pin: we block ONLY on an affirmative statement by the receiving
 * server, and treat every ambiguous answer as permission to proceed. Blocking
 * on an ambiguous answer would silently discard good mail every time our IP is
 * greylisted — the failure mode is invisible, because a message never sent is
 * never missed.
 *
 * Measured on the run that motivated this (2026-09-17, 125 outbound job
 * applications): 5 bounced, and every one of them carried the same server
 * reply — `550 5.1.1 user unknown`. That exact string is the regression case
 * below.
 */

const probeReturning = (verdict: MailboxVerdict): MailboxProbe => vi.fn(async () => verdict);

function fakeSmtpServer(replies: string[], opts: { splitAt?: string } = {}) {
  const server = new EventEmitter();
  const writes: string[] = [];
  const emitReply = (reply: string): void => {
    const bytes = Buffer.from(`${reply}\r\n`);
    const marker = opts.splitAt ? Buffer.from(opts.splitAt, 'utf8') : null;
    const markerOffset = marker ? bytes.indexOf(marker) : -1;
    if (marker && marker.length > 1 && markerOffset >= 0) {
      const boundary = markerOffset + 1;
      setTimeout(() => {
        server.emit('data', bytes.subarray(0, boundary));
        setTimeout(() => server.emit('data', bytes.subarray(boundary)), 0);
      }, 0);
      return;
    }
    setTimeout(() => server.emit('data', bytes), 0);
  };
  const socket = Object.assign(server, {
    setTimeout: vi.fn(),
    destroy: vi.fn(),
    write: (line: string) => {
      writes.push(line.replace(/\r\n$/, ''));
      const reply = replies.shift();
      if (reply) emitReply(reply);
      return true;
    },
  }) as unknown as Socket;
  smtpMocks.createConnection.mockImplementation(() => {
    queueMicrotask(() => {
      server.emit('connect');
      setTimeout(() => server.emit('data', Buffer.from('220 mx.example.test ESMTP\r\n')), 0);
    });
    return socket;
  });
  return { writes, socket };
}

describe('probeMailbox SMTP envelope', () => {
  it('uses a null sender and still blocks an explicit RCPT TO mailbox rejection', async () => {
    const smtp = fakeSmtpServer([
      '250 mx.example.test',
      '250 sender accepted',
      '550 5.1.1 user unknown',
    ]);
    smtpMocks.resolveMx.mockResolvedValue([{ priority: 10, exchange: 'mx.example.test' }]);

    const verdict = await probeMailbox('jobs@greenerwave.com');

    expect(smtp.writes).toEqual([
      'EHLO papercusp.local',
      'MAIL FROM:<>',
      'RCPT TO:<jobs@greenerwave.com>',
      'QUIT',
    ]);
    expect(verdict).toEqual({ status: 'undeliverable', reason: 'mailbox-rejected', detail: '550 5.1.1 user unknown' });
    expect(verdictBlocks(verdict)).toBe(true);
  });

  it('preserves a multibyte SMTP reply split across data events', async () => {
    const smtp = fakeSmtpServer([
      '250 mx.example.test',
      '250 sender accepted',
      '550 5.1.1 boîte introuvable',
    ], { splitAt: 'î' });
    smtpMocks.resolveMx.mockResolvedValue([{ priority: 10, exchange: 'mx.example.test' }]);

    const verdict = await probeMailbox('jobs@greenerwave.com');

    expect(verdict).toEqual({
      status: 'undeliverable',
      reason: 'mailbox-rejected',
      detail: '550 5.1.1 boîte introuvable',
    });
  });

  it('treats a MAIL FROM sender-domain refusal as unknown, not a dead recipient', async () => {
    const smtp = fakeSmtpServer([
      '250 mx.example.test',
      '550 5.1.8 <postmaster@papercusp.local>: Sender address rejected: Domain not found',
    ]);
    smtpMocks.resolveMx.mockResolvedValue([{ priority: 10, exchange: 'mx.example.test' }]);

    const verdict = await probeMailbox('jobs@greenerwave.com', {
      identity: { helo: 'papercusp.local', mailFrom: 'postmaster@papercusp.local' },
    });

    expect(smtp.writes).toEqual(['EHLO papercusp.local', 'MAIL FROM:<postmaster@papercusp.local>', 'QUIT']);
    expect(verdict).toMatchObject({
      status: 'unknown',
      reason: 'probe-refused',
      detail: 'MAIL FROM 550 5.1.8 <postmaster@papercusp.local>: Sender address rejected: Domain not found',
    });
    await expect(assertDeliverableAddressees(['jobs@greenerwave.com'], { probe: async () => verdict }))
      .resolves.toMatchObject([{ verdict: { status: 'unknown' } }]);
  });
});

describe('classifyRcptReply — the SMTP leg of the decision, in isolation', () => {
  it('treats a 2xx acceptance as deliverable', () => {
    expect(classifyRcptReply(250, 'OK')).toEqual({ status: 'deliverable' });
    expect(classifyRcptReply(251, 'User not local; will forward')).toEqual({ status: 'deliverable' });
  });

  it('treats any 5xx as the server naming the mailbox dead', () => {
    // The literal reply behind all 5 real bounces.
    expect(classifyRcptReply(550, '5.1.1 user unknown')).toEqual({
      status: 'undeliverable',
      reason: 'mailbox-rejected',
      detail: '550 5.1.1 user unknown',
    });
    for (const code of [551, 553, 554]) {
      expect(classifyRcptReply(code, 'no such user').status).toBe('undeliverable');
    }
  });

  it('NEVER concludes anything from a 4xx — greylisting is not evidence about the mailbox', () => {
    for (const code of [421, 450, 451, 452]) {
      const verdict = classifyRcptReply(code, 'try again later');
      expect(verdict.status).toBe('unknown');
      expect(verdict).toMatchObject({ reason: 'transient' });
    }
  });

  it('treats an out-of-range reply as unknown rather than guessing', () => {
    expect(classifyRcptReply(100, 'nonsense').status).toBe('unknown');
  });

  it('quotes the server verbatim so the caller can act on the real reason', () => {
    const verdict = classifyRcptReply(550, '5.1.1 <a@b.com>: Recipient address rejected');
    expect(verdict).toMatchObject({ detail: expect.stringContaining('Recipient address rejected') });
  });
});

describe('verdictBlocks — exactly one status blocks', () => {
  it('blocks undeliverable and nothing else', () => {
    expect(verdictBlocks({ status: 'undeliverable', reason: 'mailbox-rejected', detail: 'x' })).toBe(true);
    expect(verdictBlocks({ status: 'undeliverable', reason: 'no-mail-exchanger', detail: 'x' })).toBe(true);
    expect(verdictBlocks({ status: 'deliverable' })).toBe(false);
    expect(verdictBlocks({ status: 'catch-all' })).toBe(false);
    for (const reason of ['probe-refused', 'timeout', 'transient', 'probe-error'] as const) {
      expect(verdictBlocks({ status: 'unknown', reason, detail: 'x' })).toBe(false);
    }
  });
});

describe('assertDeliverableAddressees — blocks only on server-stated failure', () => {
  it('refuses a send when the server rejected the mailbox', async () => {
    const probe = probeReturning({
      status: 'undeliverable',
      reason: 'mailbox-rejected',
      detail: '550 5.1.1 user unknown',
    });
    await expect(assertDeliverableAddressees(['ghost@example.com'], { probe })).rejects.toThrow(
      UndeliverableAddressee,
    );
  });

  it('refuses a send when the domain can receive no mail at all', async () => {
    const probe = probeReturning({
      status: 'undeliverable',
      reason: 'no-mail-exchanger',
      detail: 'nowhere.invalid publishes no MX and no address record',
    });
    await expect(assertDeliverableAddressees(['a@nowhere.invalid'], { probe })).rejects.toMatchObject({
      code: 'mail_send_undeliverable_recipient',
      reason: 'no-mail-exchanger',
    });
  });

  it('names the address and quotes the server, so the error is actionable', async () => {
    const probe = probeReturning({
      status: 'undeliverable',
      reason: 'mailbox-rejected',
      detail: '550 5.1.1 user unknown',
    });
    await expect(assertDeliverableAddressees(['ghost@example.com'], { probe })).rejects.toThrow(
      /ghost@example\.com.*550 5\.1\.1 user unknown/s,
    );
  });

  it('points the caller at the override rather than leaving them stuck', async () => {
    const probe = probeReturning({ status: 'undeliverable', reason: 'mailbox-rejected', detail: '550' });
    await expect(assertDeliverableAddressees(['ghost@example.com'], { probe })).rejects.toThrow(
      /allowUndeliverable/,
    );
  });

  // ── The other half of the rule: everything ambiguous must PASS. ──

  it('ALLOWS a 4xx — a greylisted IP must not silently discard good mail', async () => {
    const probe = probeReturning({ status: 'unknown', reason: 'transient', detail: '450 try later' });
    await expect(assertDeliverableAddressees(['real@example.com'], { probe })).resolves.toMatchObject([
      { address: 'real@example.com', verdict: { status: 'unknown' } },
    ]);
  });

  it('ALLOWS a timeout', async () => {
    const probe = probeReturning({ status: 'unknown', reason: 'timeout', detail: 'smtp_timeout' });
    await expect(assertDeliverableAddressees(['real@example.com'], { probe })).resolves.toHaveLength(1);
  });

  it('ALLOWS a refused probe — Google and many hosts refuse probes outright', async () => {
    const probe = probeReturning({ status: 'unknown', reason: 'probe-refused', detail: 'ECONNREFUSED' });
    await expect(assertDeliverableAddressees(['real@gmail.com'], { probe })).resolves.toHaveLength(1);
  });

  it('ALLOWS a catch-all domain, and reports it so the caller knows acceptance meant nothing', async () => {
    const probe = probeReturning({ status: 'catch-all' });
    const reports = await assertDeliverableAddressees(['cto@housecat.com'], { probe });
    expect(reports).toEqual([{ address: 'cto@housecat.com', verdict: { status: 'catch-all' } }]);
  });

  it('ALLOWS when our own probe THROWS — a broken instrument is not evidence about the mailbox', async () => {
    const probe: MailboxProbe = vi.fn(async () => {
      throw new Error('dns exploded');
    });
    const reports = await assertDeliverableAddressees(['real@example.com'], { probe });
    expect(reports[0]!.verdict).toMatchObject({ status: 'unknown', reason: 'probe-error' });
  });

  it('honours allowUndeliverable for a caller who means it', async () => {
    const probe = probeReturning({
      status: 'undeliverable',
      reason: 'mailbox-rejected',
      detail: '550 5.1.1 user unknown',
    });
    const reports = await assertDeliverableAddressees(['ghost@example.com'], {
      probe,
      allowUndeliverable: true,
    });
    expect(reports[0]!.verdict.status).toBe('undeliverable');
  });

  it('refuses the whole send when ANY recipient is dead, matching the trust rail', async () => {
    const probe: MailboxProbe = vi.fn(async (address) =>
      address === 'ghost@example.com'
        ? ({ status: 'undeliverable', reason: 'mailbox-rejected', detail: '550' } as const)
        : ({ status: 'deliverable' } as const),
    );
    await expect(
      assertDeliverableAddressees(['fine@example.com', 'ghost@example.com'], { probe }),
    ).rejects.toThrow(UndeliverableAddressee);
  });

  it('probes every address and reports each one when all are sendable', async () => {
    const probe: MailboxProbe = vi.fn(async () => ({ status: 'deliverable' }) as const);
    const reports = await assertDeliverableAddressees(['a@x.com', 'b@y.com'], { probe });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(reports.map((r) => r.address)).toEqual(['a@x.com', 'b@y.com']);
  });

  it('does nothing at all for an empty recipient list', async () => {
    const probe: MailboxProbe = vi.fn(async () => ({ status: 'deliverable' }) as const);
    await expect(assertDeliverableAddressees([], { probe })).resolves.toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  /**
   * The recurrence guard for this rail's one systemic hazard.
   *
   * Adding the preflight to the shared send path gave every existing mail test a
   * live DNS/SMTP dependency it never asked for. Those tests DID go red — but
   * only by luck: their fixtures use `company.example`, a reserved TLD that
   * resolves to nothing and fails instantly. A fixture addressed at a
   * real-looking domain would instead resolve, connect, time out after 8s and
   * return `unknown` — which the rail correctly treats as ALLOW, so the test
   * PASSES while making a real outbound connection.
   *
   * Loud-by-luck is not a detector. These two pin the real one.
   */
  describe('omitted-probe guard', () => {
    it('REFUSES to fall through to the live network probe inside a test', async () => {
      await expect(assertDeliverableAddressees(['someone@example.com'])).rejects.toThrow(
        /deliverability_probe_not_injected/,
      );
    });

    it('names its own remedy, and that remedy works', async () => {
      // A guard whose message does not say what to do just relocates the puzzle.
      await expect(assertDeliverableAddressees(['someone@example.com'])).rejects.toThrow(
        /allowAllMailboxProbe/,
      );
      await expect(
        assertDeliverableAddressees(['someone@example.com'], { probe: allowAllMailboxProbe }),
      ).resolves.toEqual([
        { address: 'someone@example.com', verdict: { status: 'unknown', reason: 'probe-refused', detail: expect.any(String) } },
      ]);
    });

    it('treats the stub as non-blocking, so injecting it can never mask a real refusal', async () => {
      // If the stub ever came back `deliverable`, every test injecting it would
      // silently stop exercising the allow path this rail is built on.
      const [report] = await assertDeliverableAddressees(['someone@example.com'], {
        probe: allowAllMailboxProbe,
      });
      expect(verdictBlocks(report!.verdict)).toBe(false);
    });
  });
});

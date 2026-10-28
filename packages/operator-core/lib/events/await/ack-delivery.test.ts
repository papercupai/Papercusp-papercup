/**
 * ack-delivery.test.ts — a claimed delivery may be subscriber-ACKed only after
 * the capability-gated pty host confirms its exact pre-write cancellation barrier.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockResolvedTyped } from '../../testing/typed-mock';

type SqlResponse = (text: string, values: unknown[]) => unknown;

const sqlState = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; values: unknown[] }>,
  order: [] as Array<{ kind: 'sql' | 'host'; text?: string; values?: unknown[] }>,
  respond: (() => []) as SqlResponse,
}));
const pty = vi.hoisted(() => ({
  findLiveHostAsync: vi.fn(),
  hostSupports: vi.fn(),
  injectIntoHostWithConfirmation: vi.fn(),
}));

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  let text = strings[0] ?? '';
  values.forEach((value, index) => {
    text += value && typeof value === 'object' && '__text' in (value as object)
      ? (value as { __text: string }).__text
      : '$';
    text += strings[index + 1] ?? '';
  });
  let result: Promise<unknown> | null = null;
  const run = () => {
    if (!result) {
      const call = { text, values };
      sqlState.calls.push(call);
      sqlState.order.push({ kind: 'sql', ...call });
      result = Promise.resolve().then(() => sqlState.respond(text, values));
    }
    return result;
  };
  return {
    __text: text,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => run().then(resolve, reject),
  };
}

vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));
vi.mock('./psu-pty-discovery', () => ({
  PSU_PTY_DIR: '/test/psu-pty',
  findLiveHostAsync: pty.findLiveHostAsync,
  hostSupports: pty.hostSupports,
  injectIntoHostWithConfirmation: pty.injectIntoHostWithConfirmation,
}));

const schema = await import('./turn-proof-schema');
const store = await import('./store');

function configureDb(options: { settleDelivering?: boolean } = {}) {
  sqlState.respond = (text, values) => {
    if (text.includes('pg_attribute')) return [{ n: schema.TURN_PROOF_COLUMNS.length }];
    if (text.includes('SELECT status')) return [{ status: 'delivering' }];
    if (text.includes('UPDATE harness_shared.event_wake_deliveries')) {
      const allowDelivering = values[4] === true;
      return allowDelivering && options.settleDelivering ? [{ id: 7 }] : [];
    }
    return [];
  };
}

function configureAcceptedParkedDb() {
  const row: { status: string; channel: string; turnProof: string; lastError: string } = {
    status: 'parked',
    channel: 'psu-socket-inject',
    turnProof: 'awaiting',
    lastError: 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable',
  };
  sqlState.respond = (text) => {
    if (text.includes('pg_attribute')) return [{ n: schema.TURN_PROOF_COLUMNS.length }];
    if (text.includes('SELECT status')) {
      const selected = { status: row.status, channel: row.channel };
      return text.includes('last_error AS "lastError"')
        ? [{ ...selected, turnProof: row.turnProof, lastError: row.lastError }]
        : [selected];
    }
    if (text.includes('UPDATE harness_shared.event_wake_deliveries')) {
      if (text.includes("channel = 'suppressed-redundant'")) {
        if (!text.includes("status IN ('pending', 'parked', 'delivering', 'delivered')")) return [];
        row.status = 'delivered';
        row.channel = 'suppressed-redundant';
        row.turnProof = 'superseded';
        row.lastError = 'host confirmed cancelled-before-write during handled-message settlement';
        return [{ id: 7 }];
      }
      if (text.includes("SET status = 'parked'")) {
        if (text.includes("AND status IN ('pending', 'parked', 'delivering')") && row.status === 'delivered') return [];
        row.status = 'parked';
        row.lastError = 'stale pump park result';
        return [{ id: 7 }];
      }
      if (row.status === 'parked' && row.lastError.startsWith('psu-host accepted:')) {
        if (text.includes('last_error LIKE ANY')) return [];
        row.status = 'delivered';
        return [{ id: 7 }];
      }
      return [];
    }
    return [];
  };
  return row;
}
beforeEach(() => {
  sqlState.calls = [];
  sqlState.order = [];
  configureDb();
  schema.setTurnProofColumnsReadyForTests(null);
  vi.clearAllMocks();
  vi.mocked(pty.findLiveHostAsync).mockResolvedValue({ sock: '/test/host.sock' });
  vi.mocked(pty.hostSupports).mockReturnValue(true);
  vi.mocked(pty.injectIntoHostWithConfirmation).mockImplementation(async () => {
    sqlState.order.push({ kind: 'host' });
    return { ok: true, confirmation: 'acked', reason: 'cancel-requested' } as never;
  });
});

describe('ackDelivery for a pump-claimed row', () => {
  it('retries an owned parked wake after the pump reparks it between the ACK update and state read', async () => {
    schema.setTurnProofColumnsReadyForTests(true);
    let updateCount = 0;
    sqlState.respond = (text) => {
      if (text.includes('UPDATE harness_shared.event_wake_deliveries')) {
        updateCount += 1;
        return updateCount === 1 ? [] : [{ id: 7 }];
      }
      if (text.includes('SELECT status, channel')) return [{ status: 'parked', channel: 'inbox' }];
      return [];
    };

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: true,
      alreadySettled: false,
    });
    expect(updateCount).toBe(2);
    expect(pty.findLiveHostAsync).not.toHaveBeenCalled();
  });

  it('keeps an owned parked wake active if the bounded ACK reconciliation still misses', async () => {
    schema.setTurnProofColumnsReadyForTests(true);
    let updateCount = 0;
    sqlState.respond = (text) => {
      if (text.includes('UPDATE harness_shared.event_wake_deliveries')) {
        updateCount += 1;
        return [];
      }
      if (text.includes('SELECT status, channel')) return [{ status: 'parked', channel: 'inbox' }];
      return [];
    };

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: false,
      alreadySettled: false,
      status: 'parked',
    });
    expect(updateCount).toBe(3);
  });

  it('cancels a parked host-owned delivery before acknowledging a handled message', async () => {
    schema.setTurnProofColumnsReadyForTests(true);
    const row = configureAcceptedParkedDb();
    vi.mocked(pty.injectIntoHostWithConfirmation).mockImplementation(async () => {
      sqlState.order.push({ kind: 'host' });
      return { ok: true, confirmation: 'acked', reason: 'cancelled-before-write' } as never;
    });

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: true,
      alreadySettled: false,
    });

    const directAck = sqlState.calls.find((call) =>
      call.text.includes('UPDATE harness_shared.event_wake_deliveries') &&
      !call.text.includes("channel = 'suppressed-redundant'"),
    );
    const suppression = sqlState.calls.find((call) => call.text.includes("channel = 'suppressed-redundant'"));
    expect(directAck?.text).toContain('last_error LIKE ANY');
    expect(sqlState.calls.find((call) => call.text.includes('SELECT status'))?.text).toContain('last_error AS "lastError"');
    expect(suppression?.text).toContain("status IN ('pending', 'parked', 'delivering', 'delivered')");
    expect(pty.injectIntoHostWithConfirmation).toHaveBeenCalledWith('/test/host.sock', {
      mode: 'delivery-cancel', data: '', ownerId: 'su-ack', deliveryId: '7',
    });
    const hostIndex = sqlState.order.findIndex((entry) => entry.kind === 'host');
    const suppressionIndex = sqlState.order.findIndex((entry) =>
      entry.kind === 'sql' && entry.text?.includes("channel = 'suppressed-redundant'"),
    );
    expect(hostIndex).toBeGreaterThan(-1);
    expect(suppressionIndex).toBeGreaterThan(hostIndex);
    expect(row.status).toBe('delivered');

    // A pump attempt that started before this ACK can finish afterward. Its stale
    // park result must not reopen the terminally suppressed delivery.
    await store.markDeliveryParked(7, 'stale pump park result', 60_000);
    expect(row).toMatchObject({ status: 'delivered', channel: 'suppressed-redundant' });
    expect(sqlState.calls.at(-1)?.text).toContain("AND status IN ('pending', 'parked', 'delivering')");
  });

  it('keeps a parked host-owned delivery active when the host only accepts cancellation request', async () => {
    schema.setTurnProofColumnsReadyForTests(true);
    configureAcceptedParkedDb();

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: false,
      alreadySettled: false,
      status: 'parked',
      cancellationRequested: true,
    });

    expect(sqlState.calls.some((call) => call.text.includes("channel = 'suppressed-redundant'"))).toBe(false);
  });

  it('does not send the new control mode to a host without the advertised capability', async () => {
    vi.mocked(pty.hostSupports).mockReturnValue(false);

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: false,
      alreadySettled: false,
      status: 'delivering',
    });

    expect(pty.findLiveHostAsync).toHaveBeenCalledWith('su-ack', '/test/psu-pty');
    expect(pty.hostSupports).toHaveBeenCalledWith({ sock: '/test/host.sock' }, 'delivery-cancel');
    expect(pty.injectIntoHostWithConfirmation).not.toHaveBeenCalled();
    expect(sqlState.calls.some((call) => call.values[4] === true)).toBe(false);
  });

  it('keeps delivering when the host accepted a cancellation request without confirming the barrier', async () => {
    vi.mocked(pty.injectIntoHostWithConfirmation).mockImplementation(async () => {
      sqlState.order.push({ kind: 'host' });
      return { ok: true, confirmation: 'acked', reason: 'cancel-requested' } as never;
    });

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: false,
      alreadySettled: false,
      status: 'delivering',
      cancellationRequested: true,
    });

    expect(pty.injectIntoHostWithConfirmation).toHaveBeenCalledWith('/test/host.sock', {
      mode: 'delivery-cancel', data: '', ownerId: 'su-ack', deliveryId: '7',
    });
    expect(sqlState.calls.some((call) => call.values[4] === true)).toBe(false);
  });

  it('settles delivering only after an ACKed cancelled-before-write receipt', async () => {
    configureDb({ settleDelivering: true });
    vi.mocked(pty.injectIntoHostWithConfirmation).mockImplementation(async () => {
      sqlState.order.push({ kind: 'host' });
      return { ok: true, confirmation: 'acked', reason: 'cancelled-before-write' } as never;
    });

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: true,
      alreadySettled: false,
    });

    const hostIndex = sqlState.order.findIndex((entry) => entry.kind === 'host');
    const deliveringUpdateIndex = sqlState.order.findIndex((entry) =>
      entry.kind === 'sql' && entry.text?.includes('UPDATE harness_shared.event_wake_deliveries') && entry.values?.[4] === true,
    );
    expect(hostIndex).toBeGreaterThan(-1);
    expect(deliveringUpdateIndex).toBeGreaterThan(hostIndex);
  });

  it('does not treat an assumed socket close as a pre-write receipt', async () => {
    configureDb({ settleDelivering: true });
    vi.mocked(pty.injectIntoHostWithConfirmation).mockImplementation(async () => {
      sqlState.order.push({ kind: 'host' });
      return { ok: true, confirmation: 'assumed-close', reason: 'cancelled-before-write' } as never;
    });

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: false,
      alreadySettled: false,
      status: 'delivering',
    });
    expect(sqlState.calls.some((call) => call.values[4] === true)).toBe(false);
  });

  it('recalls a delivered but unconfirmed socket wake before a handled-message replay', async () => {
    schema.setTurnProofColumnsReadyForTests(true);
    sqlState.respond = (text) => {
      if (text.includes('pg_attribute')) return [{ n: schema.TURN_PROOF_COLUMNS.length }];
      if (text.includes('SELECT status, channel')) {
        return [{ status: 'delivered', channel: 'psu-socket-inject', turnProof: 'awaiting' }];
      }
      if (text.includes("channel = 'suppressed-redundant'")) return [{ id: 7 }];
      return [];
    };
    mockResolvedTyped(vi.mocked(pty.injectIntoHostWithConfirmation), {
      ok: true, confirmation: 'acked', reason: 'cancelled-before-write',
    });

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: true,
      alreadySettled: false,
    });
    expect(pty.injectIntoHostWithConfirmation).toHaveBeenCalledWith('/test/host.sock', {
      mode: 'delivery-cancel', data: '', ownerId: 'su-ack', deliveryId: '7',
    });
    expect(sqlState.calls.some((call) => call.text.includes("channel = 'suppressed-redundant'"))).toBe(true);
  });

  it.each([
    ['cancel request is still pending', 'cancel-requested', { cancellationRequested: true }],
    ['host already committed the write', 'delivery-already-committed', {}],
    ['host has already seen this delivery id', 'duplicate-delivery-id', {}],
  ])('preserves a delivered unconfirmed wake when %s', async (_label, reason, extra) => {
    schema.setTurnProofColumnsReadyForTests(true);
    sqlState.respond = (text) => {
      if (text.includes('pg_attribute')) return [{ n: schema.TURN_PROOF_COLUMNS.length }];
      if (text.includes('SELECT status, channel')) {
        return [{ status: 'delivered', channel: 'psu-socket-inject', turnProof: 'awaiting' }];
      }
      return [];
    };
    mockResolvedTyped(vi.mocked(pty.injectIntoHostWithConfirmation), {
      ok: true, confirmation: 'acked', reason,
    });

    await expect(store.ackDelivery({ deliveryId: 7, subscriberId: 'su-ack' })).resolves.toEqual({
      acked: false,
      alreadySettled: false,
      status: 'delivered',
      ...extra,
    });
    expect(sqlState.calls.some((call) => call.text.includes("channel = 'suppressed-redundant'"))).toBe(false);
  });

  it('bulk turn-end settlement recalls delivered unconfirmed socket wakes', async () => {
    schema.setTurnProofColumnsReadyForTests(true);
    sqlState.respond = (text) => {
      if (text.includes('pg_attribute')) return [{ n: schema.TURN_PROOF_COLUMNS.length }];
      if (text.includes('SELECT d.id')) return [{ id: 7 }];
      if (text.includes("channel = 'suppressed-redundant'")) return [{ id: 7 }];
      return [];
    };
    mockResolvedTyped(vi.mocked(pty.injectIntoHostWithConfirmation), {
      ok: true, confirmation: 'acked', reason: 'cancelled-before-write',
    });

    await expect(store.settleCaughtUpInboxWakeDeliveries({
      subscriberId: 'su-ack',
      cutoffTs: new Date().toISOString(),
    })).resolves.toBe(1);
    expect(pty.injectIntoHostWithConfirmation).toHaveBeenCalledWith('/test/host.sock', {
      mode: 'delivery-cancel', data: '', ownerId: 'su-ack', deliveryId: '7',
    });
  });
});

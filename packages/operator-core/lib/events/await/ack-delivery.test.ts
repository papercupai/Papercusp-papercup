/**
 * ack-delivery.test.ts — a claimed delivery may be subscriber-ACKed only after
 * the capability-gated pty host confirms its exact pre-write cancellation barrier.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      const allowDelivering = values[values.length - 1] === true;
      return allowDelivering && options.settleDelivering ? [{ id: 7 }] : [];
    }
    return [];
  };
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
    expect(sqlState.calls.some((call) => call.values[call.values.length - 1] === true)).toBe(false);
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
    expect(sqlState.calls.some((call) => call.values[call.values.length - 1] === true)).toBe(false);
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
      entry.kind === 'sql' && entry.text?.includes('UPDATE harness_shared.event_wake_deliveries') && entry.values?.at(-1) === true,
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
    expect(sqlState.calls.some((call) => call.values[call.values.length - 1] === true)).toBe(false);
  });
});

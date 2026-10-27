/**
 * The injection hook tells the operator its own wall (WI-10004485 step C), so the
 * Jev memory filter waits only for what is left of it (operator-core
 * jev-memory-gate.ts: jevMemoryWaitMs; turn-start-memory.ts turns `wallMs` into
 * respondByMs). The number is derived from each port spec's timeoutMs minus the
 * time the hook already spent before the request left (local code-intelligence
 * collection on the mid-turn port), sent with every request, never a second copy
 * kept on the server (code-intel-delivery-and-outcomes-2026-10-26#P-002).
 *
 * Lives beside core.mjs on purpose: test selection is by workspace, so a test in
 * another package would not run when this hook changes.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { postInjection } = await import(path.join(HERE, '..', 'core.mjs'));
const { PORTS } = (await import(path.join(HERE, '..', 'ports.mjs'))) as {
  PORTS: Record<string, { timeoutMs: number }>;
};

const capture = () => {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return { ok: true, json: async () => ({ text: 'x' }) };
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
};

/** A clock that returns the given readings in order, then repeats the last. */
const clock = (...readings: number[]) => {
  let i = 0;
  return () => readings[Math.min(i++, readings.length - 1)]!;
};

describe('injection hook → operator: the wall travels with the request', () => {
  it('covers at least one port (positive control: an empty PORTS would pass every case vacuously)', () => {
    expect(Object.keys(PORTS).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(PORTS))('port %s sends its whole timeoutMs when no time was spent before the request, alongside the caller’s body', async (port) => {
    const { sent, fetchImpl } = capture();

    await postInjection(port, { owner: 'su-test', prompt: 'hello' }, { env: {}, fetchImpl, now: () => 5_000 });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ owner: 'su-test', prompt: 'hello', wallMs: PORTS[port]!.timeoutMs });
  });

  it.each(Object.keys(PORTS))('port %s sends only what is left of its wall after time already spent', async (port) => {
    const { sent, fetchImpl } = capture();
    const spent = Math.floor(PORTS[port]!.timeoutMs / 2);

    await postInjection(port, { owner: 'su-test', prompt: 'hello' }, { env: {}, fetchImpl, now: clock(10_000, 10_000 + spent) });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.wallMs).toBe(PORTS[port]!.timeoutMs - spent);
  });

  it('never sends a zero or negative wall when the clock reads past the timeout (the server treats <= 0 as "no wall")', async () => {
    const port = Object.keys(PORTS)[0]!;
    const { sent, fetchImpl } = capture();

    await postInjection(port, { owner: 'su-test', prompt: 'hello' }, { env: {}, fetchImpl, now: clock(0, PORTS[port]!.timeoutMs + 500) });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.wallMs).toBe(1);
  });
});

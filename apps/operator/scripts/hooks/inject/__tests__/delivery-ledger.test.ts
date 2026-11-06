/**
 * delivery-ledger.mjs — the hook half of turn-start ACK-ON-PROOF
 * (owner-directive-delivery-redesign-2026-09-22 P-005). The end-to-end
 * "printed, then recorded" property is driven through the real CLI in
 * dispatcher.test.ts; these pin the module's own edges.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  ledgerDir, openDeliveryLedger, codeIntelDelivery, MAX_DELIVERY_RECEIPTS, MAX_TURN_START_OUTCOME_RECEIPTS,
} = await import(path.join(HERE, '..', 'delivery-ledger.mjs'));
const { runInjection, postInjection } = await import(path.join(HERE, '..', 'core.mjs'));

const home = () => ({ PAPERCUSP_HOME: mkdtempSync(path.join(tmpdir(), 'ledger-unit-')) });
type CodeIntelState = { turn: string; chars: number; subjects: string[] };

describe('delivery ledger', () => {
  it('confirms only what was offered AND committed', () => {
    const env = home();
    const ledger = openDeliveryLedger('su-1', env);
    expect(ledger.confirmed()).toBeNull();
    // Commit before any offer records nothing.
    expect(ledger.commit()).toBe(false);
    ledger.offer('tok-1');
    // Offered is not proven: a fresh process still reads nothing.
    expect(openDeliveryLedger('su-1', env).confirmed()).toBeNull();
    expect(ledger.commit()).toBe(true);
    expect(openDeliveryLedger('su-1', env).confirmed()).toBe('tok-1');
  });

  it('keeps one token per session and leaves no temp file behind', () => {
    const env = home();
    const a = openDeliveryLedger('su-a', env);
    const b = openDeliveryLedger('su-b', env);
    a.offer('tok-a');
    b.offer('tok-b');
    a.commit();
    b.commit();
    expect(openDeliveryLedger('su-a', env).confirmed()).toBe('tok-a');
    expect(readdirSync(ledgerDir(env)).sort()).toEqual(['su-a.emissions', 'su-a.token', 'su-b.emissions', 'su-b.token']);
  });

  it('cannot be steered outside its directory by the session id', () => {
    const env = home();
    const ledger = openDeliveryLedger('../../escape', env);
    ledger.offer('tok-x');
    ledger.commit();
    expect(readdirSync(ledgerDir(env)).sort()).toEqual(['.._.._escape.emissions', '.._.._escape.token']);
  });

  it('opens nothing without a session id', () => {
    expect(openDeliveryLedger('', home())).toBeNull();
    expect(openDeliveryLedger(undefined, home())).toBeNull();
  });

  it('preserves the original token and distinct control revisions across a fresh successor', () => {
    const env = home();
    const desired = { specificationRevision: '1'.repeat(64), stateRevision: '2'.repeat(64) };
    const applied = { ...desired, stateRevision: '3'.repeat(64) };
    const payload = 'private hook context\n';
    const first = openDeliveryLedger('su-1', env);
    first.offer('token-before-carry', { payload, client: 'codex', nativeSessionId: 'native-before',
      control: { targetOwnerId: 'su-1', generation: 18, stateHash: '4'.repeat(64),
        state: { activation: { status: 'prepared', desired, prepared: desired, applied },
          privateText: 'private hook context' } } });
    const receipts = path.join(ledgerDir(env), 'su-1.emissions');
    expect(existsSync(receipts)).toBe(false);
    expect(first.commit()).toBe(true);
    const originalPath = path.join(receipts, readdirSync(receipts)[0]);
    const originalBytes = readFileSync(originalPath, 'utf8');
    expect(JSON.parse(originalBytes)).toMatchObject({ stage: 'stdout-emitted', token: 'token-before-carry',
      nativeSessionId: 'native-before', payloadSha256: createHash('sha256').update(payload).digest('hex'),
      payloadBytes: Buffer.byteLength(payload), control: { generation: 18, desired, prepared: desired, applied } });
    expect(originalBytes).not.toContain('private hook context');
    const successor = openDeliveryLedger('su-1', env);
    expect(successor.confirmed()).toBe('token-before-carry');
    successor.offer('token-after-carry', { payload: 'successor\n', client: 'codex', nativeSessionId: 'native-after' });
    expect(successor.commit()).toBe(true);
    expect(openDeliveryLedger('su-1', env).confirmed()).toBe('token-after-carry');
    expect(readFileSync(originalPath, 'utf8')).toBe(originalBytes);
    // A repeated token also retains its first emission, rather than relabeling it.
    successor.offer('token-before-carry', { payload: 'different', nativeSessionId: 'native-after' });
    expect(successor.commit()).toBe(true);
    expect(readFileSync(originalPath, 'utf8')).toBe(originalBytes);
  });

  it('does not advance the current token if an immutable receipt cannot be written', () => {
    const env = home();
    const ledger = openDeliveryLedger('su-1', env);
    writeFileSync(path.join(ledgerDir(env), 'su-1.emissions'), 'not a directory');
    ledger.offer('unpreserved-token', { payload: 'printed\n' });
    expect(ledger.commit()).toBe(false);
    expect(openDeliveryLedger('su-1', env).confirmed()).toBeNull();
    expect(readdirSync(ledgerDir(env))).toEqual(['su-1.emissions']);
  });

  it('bounds retained receipts and keeps the current emission during rapid commits', () => {
    const env = home();
    const ledger = openDeliveryLedger('su-1', env);
    for (let n = 0; n < MAX_DELIVERY_RECEIPTS + 5; n++) {
      ledger.offer(`token-${n}`);
      expect(ledger.commit()).toBe(true);
    }
    const receipts = path.join(ledgerDir(env), 'su-1.emissions');
    const names = readdirSync(receipts);
    expect(names).toHaveLength(MAX_DELIVERY_RECEIPTS);
    expect(names.every(name => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
    expect(names.map(name => JSON.parse(readFileSync(path.join(receipts, name), 'utf8')).token))
      .toContain(`token-${MAX_DELIVERY_RECEIPTS + 4}`);
  });

  it('stores bounded per-request outcomes using only the privacy-safe status vocabulary', () => {
    const env = home();
    const ledger = openDeliveryLedger('su-outcome', env);
    const receiptDir = path.join(ledgerDir(env), 'su-outcome.outcomes');
    const requestId = 'request-privacy-1';
    expect(ledger.recordOutcome({
      requestId,
      client: 'codex',
      hookOutcome: 'response-received',
      serverOutcome: 'matched',
      ambientGate: 'denied',
      loopFire: true,
      loopMarkerAppend: 'appended',
      prompt: 'private prompt must not be stored',
      error: 'private error must not be stored',
      transport: {
        phase: 'private phase must not be stored',
        operatorOrigin: 'https://private-user:private-password@operator.example/private/path?private-query=1#private-fragment',
        timeoutMs: 2500,
        elapsedMs: 2500.4,
        preFetchMs: Number.NaN,
        fetchMs: -1,
        responseStatus: 200.5,
        headersElapsedMs: -1,
        responseBodyMs: Number.POSITIVE_INFINITY,
        error: 'private transport error must not be stored',
      },
    })).toBe(true);
    const storedPath = path.join(receiptDir, `${createHash('sha256').update(requestId).digest('hex')}.json`);
    const storedBytes = readFileSync(storedPath, 'utf8');
    expect(JSON.parse(storedBytes)).toMatchObject({
      version: 1,
      stage: 'turn-start-outcome',
      requestId,
      client: 'codex',
      hookOutcome: 'response-received',
      serverOutcome: 'matched',
      ambientGate: 'denied',
      loopFire: true,
      loopMarkerAppend: 'appended',
      transport: {
        phase: 'unknown',
        operatorOrigin: 'https://operator.example',
        timeoutMs: 2500,
        elapsedMs: 2500,
        preFetchMs: null,
        fetchMs: null,
        responseStatus: null,
        headersElapsedMs: null,
        responseBodyMs: null,
      },
    });
    expect(storedBytes).not.toContain('private prompt');
    expect(storedBytes).not.toContain('private error');
    expect(storedBytes).not.toContain('private-');
    expect(storedBytes).not.toContain('/private/');
    expect(storedBytes).not.toContain('private phase');
    expect(storedBytes).not.toContain('private transport error');

    for (let n = 0; n < MAX_TURN_START_OUTCOME_RECEIPTS + 4; n++) {
      expect(ledger.recordOutcome({
        requestId: `request-${n}`,
        hookOutcome: 'request-failed',
      })).toBe(true);
    }
    const names = readdirSync(receiptDir);
    expect(names).toHaveLength(MAX_TURN_START_OUTCOME_RECEIPTS);
    expect(names).toContain(`${createHash('sha256').update(`request-${MAX_TURN_START_OUTCOME_RECEIPTS + 3}`).digest('hex')}.json`);
  });

  it('records hook response and server outcome even when there is no context to print', async () => {
    const env = { ...home(), PAPERCUSP_SID: 'su-hook-outcome' };
    const adapter = {
      client: 'codex' as const,
      portForEvent: () => 'turn-start' as const,
      parse: () => ({ prompt: 'PRIVATE PROMPT', cwd: '/private/path' }),
      render: () => 'unreachable for an empty response',
    };
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { turnStartRequestId: string };
      return new Response(JSON.stringify({
        text: '',
        turnStartOutcome: {
          requestId: request.turnStartRequestId,
          ambientGate: 'denied',
          loopFire: true,
          loopMarkerAppend: 'appended',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await expect(runInjection({
      adapter,
      nativeEvent: 'UserPromptSubmit',
      event: { prompt: 'PRIVATE PROMPT' },
      env,
      fetchImpl: fetchImpl as typeof fetch,
      openDeliveryLedger,
    })).resolves.toBeNull();

    const requestId = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).turnStartRequestId;
    const outcomeDir = path.join(ledgerDir(env), 'su-hook-outcome.outcomes');
    const receipt = JSON.parse(readFileSync(
      path.join(outcomeDir, `${createHash('sha256').update(requestId).digest('hex')}.json`), 'utf8',
    ));
    expect(receipt).toMatchObject({
      stage: 'turn-start-outcome',
      requestId,
      client: 'codex',
      hookOutcome: 'response-received',
      serverOutcome: 'matched',
      ambientGate: 'denied',
      loopFire: true,
      loopMarkerAppend: 'appended',
    });
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE PROMPT');
    expect(JSON.stringify(receipt)).not.toContain('/private/path');
  });

  it('separates pre-fetch work from fetch latency on a markerless response', async () => {
    const env = { ...home(), PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:48111' };
    const owner = 'su-clock-split';
    const requestId = 'request-clock-split';
    const ledger = openDeliveryLedger(owner, env);
    let firstClockRead = true;
    const now = () => {
      if (firstClockRead) { firstClockRead = false; return 0; }
      return 4000;
    };

    await expect(postInjection('turn-start', { owner, client: 'codex', turnStartRequestId: requestId }, {
      env,
      now,
      fetchImpl: async () => new Response(JSON.stringify({ text: '', privateResponse: 'must not persist' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
      onTurnStartOutcome: (outcome: object) => ledger.recordOutcome(outcome),
    })).resolves.toBeNull();

    const receiptBytes = readFileSync(path.join(ledgerDir(env), `${owner}.outcomes`,
      `${createHash('sha256').update(requestId).digest('hex')}.json`), 'utf8');
    expect(JSON.parse(receiptBytes)).toMatchObject({
      hookOutcome: 'response-received',
      serverOutcome: 'missing',
      loopMarkerAppend: 'unknown',
      transport: {
        phase: 'body-received',
        timeoutMs: 2500,
        elapsedMs: 4000,
        preFetchMs: 4000,
        fetchMs: 0,
        responseStatus: 202,
        headersElapsedMs: 4000,
        responseBodyMs: 0,
      },
    });
    expect(receiptBytes).not.toContain('must not persist');
    expect(receiptBytes).not.toContain('privateResponse');
  });

  it('records an unreceived response without retaining transport error text', async () => {
    const env = { ...home(), PAPERCUSP_SID: 'su-hook-no-response' };
    const adapter = {
      client: 'codex' as const,
      portForEvent: () => 'turn-start' as const,
      parse: () => ({ prompt: 'PRIVATE PROMPT' }),
      render: () => 'must not render',
    };
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      throw new Error('private transport detail');
    });

    await expect(runInjection({
      adapter,
      nativeEvent: 'UserPromptSubmit',
      event: {},
      env,
      fetchImpl: fetchImpl as typeof fetch,
      openDeliveryLedger,
    })).resolves.toBeNull();

    const request = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as { turnStartRequestId: string };
    const receiptDir = path.join(ledgerDir(env), 'su-hook-no-response.outcomes');
    const receipt = JSON.parse(readFileSync(
      path.join(receiptDir, `${createHash('sha256').update(request.turnStartRequestId).digest('hex')}.json`), 'utf8',
    ));
    expect(receipt).toMatchObject({
      hookOutcome: 'request-failed',
      serverOutcome: 'unavailable',
      ambientGate: 'unknown',
      loopFire: null,
      loopMarkerAppend: 'unknown',
      transport: {
        phase: 'waiting-for-headers',
        timeoutMs: 2500,
        elapsedMs: expect.any(Number),
        headersElapsedMs: null,
        responseBodyMs: null,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('private transport detail');
  });

  it.each(['headers', 'body'] as const)('retains the failed transport phase for a stalled %s response', async (phase) => {
    vi.useFakeTimers();
    try {
      const env = { ...home(), PAPERCUSP_SID: 'su-stalled-response', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:48111' };
      const adapter = {
        client: 'codex' as const,
        portForEvent: () => 'turn-start' as const,
        parse: () => ({ prompt: 'PRIVATE PROMPT' }),
        render: () => 'must not render',
      };
      const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const stall = () => new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('private timeout detail')), { once: true });
        });
        return phase === 'headers' ? stall() : { ok: true, json: stall } as unknown as Response;
      });
      const exchange = runInjection({
        adapter, nativeEvent: 'UserPromptSubmit', event: {}, env,
        fetchImpl: fetchImpl as typeof fetch, openDeliveryLedger,
      });
      await vi.advanceTimersByTimeAsync(2501);
      await expect(exchange).resolves.toBeNull();
      const request = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as { turnStartRequestId: string };
      const receipt = JSON.parse(readFileSync(path.join(ledgerDir(env), 'su-stalled-response.outcomes',
        `${createHash('sha256').update(request.turnStartRequestId).digest('hex')}.json`), 'utf8'));
      expect(receipt).toMatchObject({
        hookOutcome: 'request-failed',
        serverOutcome: 'unavailable',
        transport: {
          phase: phase === 'headers' ? 'waiting-for-headers' : 'reading-body',
          timeoutMs: 2500,
          elapsedMs: 2500,
          headersElapsedMs: phase === 'headers' ? null : 0,
          responseBodyMs: phase === 'headers' ? null : 2500,
        },
      });
      expect(receipt.transport.operatorOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(JSON.stringify(receipt)).not.toContain('PRIVATE PROMPT');
      expect(JSON.stringify(receipt)).not.toContain('private timeout detail');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('code intelligence delivery reservations', () => {
  it('retains source observations across turn and compaction boundaries', () => {
    const env = home();
    const observation = { path: 'a.ts', sha256: 'a'.repeat(64), at: Date.now() };
    codeIntelDelivery('su-1', env, (state: CodeIntelState & { recentEdits?: unknown[] }) => {
      state.recentEdits = [observation];
    });
    for (const boundary of ['turn-start', 'compaction']) {
      codeIntelDelivery('su-1', env, () => null, boundary);
      expect(codeIntelDelivery('su-1', env, (state: CodeIntelState & { recentEdits?: unknown[] }) => state.recentEdits))
        .toEqual([observation]);
    }
  });
  it('does not remove a competing writer lock or run its update', () => {
    const env = home();
    const lock = path.join(ledgerDir(env), 'su-1.code-intel.json.initial.lock');
    mkdirSync(lock, { recursive: true });
    let called = false;
    expect(codeIntelDelivery('su-1', env, () => { called = true; })).toBeNull();
    expect(called).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  it.each([null, { turn: 'initial', chars: -5000, subjects: [] }, { turn: '../escape', chars: 0, subjects: [] },
    { turn: 'initial', chars: 0, subjects: [null] }])('does not admit malformed persisted state %j into the budget callback', invalid => {
    const env = home();
    mkdirSync(ledgerDir(env), { recursive: true });
    writeFileSync(path.join(ledgerDir(env), 'su-1.code-intel.json'), JSON.stringify(invalid));
    let called = false;
    expect(codeIntelDelivery('su-1', env, () => { called = true; return 'advice'; })).toBeNull();
    expect(called).toBe(false);
    // A boundary can rebuild corrupt state without trusting its subjects.
    codeIntelDelivery('su-1', env, () => null, 'turn-start');
    expect(codeIntelDelivery('su-1', env, (state: CodeIntelState) => state.chars)).toBe(0);
  });

  it('does not let an old writer overwrite a completed turn boundary', () => {
    const env = home();
    codeIntelDelivery('su-1', env, (state: CodeIntelState) => { state.subjects.push('prior'); });
    expect(codeIntelDelivery('su-1', env, (state: CodeIntelState) => {
      codeIntelDelivery('su-1', env, () => null, 'turn-start');
      state.chars = 1000;
      return 'old';
    })).toBeNull();
    const current = JSON.parse(readFileSync(path.join(ledgerDir(env), 'su-1.code-intel.json'), 'utf8'));
    expect(current.chars).toBe(0);
    expect(current.subjects).toEqual(['prior']);
  });

  it('serializes concurrent fresh processes against one turn budget', async () => {
    const env = home();
    codeIntelDelivery('su-1', env, () => null, 'turn-start');
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => run(process.execPath, ['--input-type=module', '-e',
      `import { codeIntelDelivery } from ${JSON.stringify(path.join(HERE, '..', 'delivery-ledger.mjs'))};
       const result = codeIntelDelivery('su-1', ${JSON.stringify(env)}, state => {
         const until = Date.now() + 30; while (Date.now() < until) {}
         if (state.chars + 600 > 1500) return false;
         state.chars += 600; state.subjects.push(${JSON.stringify(String(n))}); return true;
       }); process.stdout.write(JSON.stringify(result));`], { env: { ...process.env, NODE_OPTIONS: '' } })));
    const admitted = results.filter(result => JSON.parse(result.stdout) === true).length;
    const state = codeIntelDelivery('su-1', env, (current: CodeIntelState) => ({ ...current }));
    expect(admitted).toBeGreaterThan(0);
    expect(state.chars).toBe(admitted * 600);
    expect(state.chars).toBeLessThanOrEqual(1500);
    expect(state.subjects).toHaveLength(admitted);
  });

  it('cannot replace a newer boundary when it lands between validation and rename', async () => {
    const env = home();
    const run = promisify(execFile);
    const result = await run(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { codeIntelDelivery, ledgerDir } from ${JSON.stringify(path.join(HERE, '..', 'delivery-ledger.mjs'))};
      const env = ${JSON.stringify(env)};
      codeIntelDelivery('su-1', env, state => { state.subjects.push('prior'); });
      const rename = fs.renameSync;
      let armed = true;
      fs.renameSync = (from, to) => {
        if (armed) {
          armed = false;
          codeIntelDelivery('su-1', env, () => null, 'turn-start');
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      const old = codeIntelDelivery('su-1', env, state => { state.chars = 1000; return 'old'; });
      const current = codeIntelDelivery('su-1', env, state => ({ chars: state.chars, subjects: state.subjects }));
      process.stdout.write(JSON.stringify({ old, current }));
    `], { env: { ...process.env, NODE_OPTIONS: '' } });
    expect(JSON.parse(result.stdout)).toEqual({ old: null, current: { chars: 0, subjects: ['prior'] } });
  });
});

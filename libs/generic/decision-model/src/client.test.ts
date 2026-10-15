import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDecisionModel,
  createDecisionClient,
  createJevProvider,
  decide,
  getDecisionClient,
  JEV_ENDPOINT,
  JEV_PINNED_MODEL,
  type DecisionCallRecord,
  type DecisionRequest,
  type FetchLike,
  type ProviderParseResult,
} from './index.js';

// ── Recorded fixtures (shapes from https://docs.typesafe.ai/api.md, 2026-09-30) ──

const CHOICE_OK = {
  model: 'jev-1.13.0',
  answers: {
    department: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 },
      confidence: 0.81,
    },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};

const MIXED_OK = {
  model: 'jev-1.13.0',
  answers: {
    anger: {
      type: 'score',
      score: 1.05,
      legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
      probabilities: { '0': 0.0, '1': 0.95, '2': 0.05 },
      confidence: 0.92,
    },
    urgent: { type: 'noul', noul: 0.95 },
  },
  usage: { input_tokens: 120, output_tokens: 12 },
};

const choiceRequest = {
  state: 'Help! My payouts have been failing for 3 days.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      options: {
        billing: 'Payments, invoicing, refunds',
        technical: 'Bugs, outages, integrations',
        sales: 'Pricing, upgrades, new accounts',
      },
    },
  },
} as const satisfies DecisionRequest;

const mixedRequest = {
  state: 'This is the THIRD time I am asking.',
  questions: {
    anger: { type: 'score', instructions: 'How angry is the customer?', levels: ['Calm', 'Frustrated', 'Very angry'] },
    urgent: {
      type: 'yesNo',
      instructions: 'Does this need a reply today?',
      criteria: { yes: 'Blocking or escalating', no: 'Can wait' },
    },
  },
} as const satisfies DecisionRequest;

// ── Test harness ──

interface Scripted {
  status: number;
  body: unknown;
  retryAfter?: string;
}

function scriptedFetch(responses: Array<Scripted | Error | 'hang' | 'deaf'>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  let i = 0;
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next === 'hang') {
      return new Promise((_, reject) => {
        // Like real fetch: an already-aborted signal rejects at once.
        if (init.signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    if (next === 'deaf') return new Promise(() => {}); // a transport that ignores its signal entirely
    if (next instanceof Error) throw next;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return {
      status: next.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? (next.retryAfter ?? null) : null) },
      text: async () => text,
    };
  };
  return { fn, calls };
}

function client(fetchImpl: FetchLike, overrides: Partial<Parameters<typeof createDecisionClient>[0]> = {}) {
  const sleeps: number[] = [];
  const c = createDecisionClient({
    provider: createJevProvider(),
    resolveKey: () => 'ts-test-key',
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // jitter factor exactly 1.0
    ...overrides,
  });
  return { c, sleeps };
}

afterEach(() => configureDecisionModel(null));

// ── Request shape ──

describe('Jev request', () => {
  it('sends the pinned versioned model, the bearer key and every question in wire form', async () => {
    const { fn, calls } = scriptedFetch([{ status: 200, body: MIXED_OK }]);
    await client(fn).c.decide(mixedRequest);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(JEV_ENDPOINT);
    expect(calls[0]!.headers.Authorization).toBe('Bearer ts-test-key');
    expect(calls[0]!.body).toEqual({
      model: JEV_PINNED_MODEL,
      state: mixedRequest.state,
      questions: {
        anger: { type: 'score', instructions: 'How angry is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
        urgent: {
          type: 'noul',
          instructions: 'Does this need a reply today?',
          criteria: { true: 'Blocking or escalating', false: 'Can wait' },
        },
      },
    });
  });

  it('never pins the moving jev-latest alias', () => {
    expect(JEV_PINNED_MODEL).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(createJevProvider().model).not.toBe('jev-latest');
  });

  it('maps choice options to criteria keys and omits noul criteria when none are given', async () => {
    const { fn, calls } = scriptedFetch([{ status: 200, body: { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.2 } } } }]);
    await client(fn).c.decide({ state: 's', questions: { q: { type: 'yesNo', instructions: 'Is it?' } } });
    expect(calls[0]!.body).toMatchObject({ questions: { q: { type: 'noul', instructions: 'Is it?' } } });
    expect((calls[0]!.body as { questions: { q: object } }).questions.q).not.toHaveProperty('criteria');
  });
});

// ── Answered ──

describe('answered outcomes', () => {
  it('parses a choice answer with typed options, usage and the model that answered', async () => {
    const { fn } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const out = await client(fn).c.decide(choiceRequest);
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    const choice: 'billing' | 'technical' | 'sales' = out.answers.department.choice;
    expect(choice).toBe('billing');
    expect(out.answers.department.probabilities).toEqual({ billing: 0.88, technical: 0.12, sales: 0 });
    expect(out.answers.department.confidence).toBe(0.81);
    expect(out.model).toBe('jev-1.13.0');
    expect(out.usage).toEqual({ inputTokens: 318, outputTokens: 34 });
    expect(out.attempts).toBe(1);
  });

  it('parses score and yes/no answers into provider-neutral shapes', async () => {
    const { fn } = scriptedFetch([{ status: 200, body: MIXED_OK }]);
    const out = await client(fn).c.decide(mixedRequest);
    expect(out.kind).toBe('answered');
    if (out.kind !== 'answered') return;
    expect(out.answers.anger).toEqual({ type: 'score', score: 1.05, probabilities: [0, 0.95, 0.05], confidence: 0.92 });
    expect(out.answers.urgent).toEqual({ type: 'yesNo', pYes: 0.95 });
  });

  it('records the model id the provider RETURNED, not the one requested', async () => {
    const { fn } = scriptedFetch([{ status: 200, body: { ...CHOICE_OK, model: 'jev-1.14.2' } }]);
    const out = await client(fn).c.decide(choiceRequest);
    expect(out.kind === 'answered' && out.model).toBe('jev-1.14.2');
  });
});

// ── Inconclusive: never an empty verdict ──

describe('fail open with a typed reason', () => {
  it('no key ⇒ no-key, and nothing is sent', async () => {
    const { fn, calls } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const out = await client(fn, { resolveKey: async () => null }).c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'no-key', attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  it('a throwing credential lookup ⇒ no-key, not a thrown error', async () => {
    const { fn, calls } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const out = await client(fn, {
      resolveKey: async () => {
        throw new Error('pg down');
      },
    }).c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'no-key' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'payment-required'],
    [422, 'rejected'],
    [500, 'http-error'],
  ] as const)('HTTP %i ⇒ %s on the first attempt, no retry', async (status, reason) => {
    const { fn, calls } = scriptedFetch([{ status, body: { detail: 'questions.department.criteria: field required' } }]);
    const { c, sleeps } = client(fn);
    const out = await c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason, status, attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('after a 402, sends nothing for the cooldown, then probes the provider again (WI-10005692)', async () => {
    const billing = { detail: { error_type: 'billing_error', message: 'no available credits' } };
    const { fn, calls } = scriptedFetch([
      { status: 402, body: billing },
      { status: 402, body: billing },
      { status: 200, body: CHOICE_OK },
    ]);
    let clock = 1_000_000;
    const { c } = client(fn, { now: () => clock, paymentRequiredCooldownMs: 60_000 });

    expect(await c.decide(choiceRequest)).toMatchObject({ kind: 'inconclusive', reason: 'payment-required', status: 402, attempts: 1 });
    expect(calls).toHaveLength(1);

    // Inside the window: answered at once, nothing sent, no status.
    clock += 59_999;
    const suspended = await c.decide(choiceRequest);
    expect(suspended).toMatchObject({ kind: 'inconclusive', reason: 'payment-required', attempts: 0 });
    expect(suspended.kind === 'inconclusive' && suspended.status).toBeUndefined();
    expect(calls).toHaveLength(1);

    // Window over: one probe. Still 402, so the window re-arms from now.
    clock += 1;
    expect(await c.decide(choiceRequest)).toMatchObject({ reason: 'payment-required', status: 402, attempts: 1 });
    expect(calls).toHaveLength(2);
    clock += 30_000;
    expect(await c.decide(choiceRequest)).toMatchObject({ reason: 'payment-required', attempts: 0 });
    expect(calls).toHaveLength(2);

    // Credits back: the next probe after the window answers.
    clock += 30_000;
    expect(await c.decide(choiceRequest)).toMatchObject({ kind: 'answered' });
    expect(calls).toHaveLength(3);
  });

  it('paymentRequiredCooldownMs: 0 turns the 402 suspension off', async () => {
    const { fn, calls } = scriptedFetch([{ status: 402, body: { detail: 'billing' } }]);
    const { c } = client(fn, { paymentRequiredCooldownMs: 0 });
    await c.decide(choiceRequest);
    await c.decide(choiceRequest);
    expect(calls).toHaveLength(2);
  });

  it('keeps the 422 body as the detail so the offending field is visible, and never leaks the key', async () => {
    const { fn } = scriptedFetch([{ status: 422, body: { detail: 'questions.department.criteria: field required' } }]);
    const out = await client(fn).c.decide(choiceRequest);
    expect(out.kind === 'inconclusive' && out.detail).toContain('questions.department.criteria');
    expect(JSON.stringify(out)).not.toContain('ts-test-key');
  });

  it('a network fault ⇒ network-error', async () => {
    const { fn } = scriptedFetch([new TypeError('fetch failed: ECONNRESET')]);
    const out = await client(fn).c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'network-error' });
  });

  it('a network fault with an EMPTY message still records why (WI-10005372)', async () => {
    // Node's connect failure on every address of a multi-address host: message '', cause in code/errors.
    const perAddress = Object.assign(new Error('connect ECONNREFUSED 104.18.24.46:443'), { code: 'ECONNREFUSED' });
    const fault = Object.assign(new AggregateError([perAddress], ''), { code: 'ECONNREFUSED' });
    const { fn } = scriptedFetch([fault]);
    const out = await client(fn).c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'network-error' });
    expect(out.kind === 'inconclusive' && out.detail).toBe(
      'AggregateError [ECONNREFUSED] (Error [ECONNREFUSED]: connect ECONNREFUSED 104.18.24.46:443)',
    );
  });

  it('a hung request ⇒ timeout within the deadline', async () => {
    const { fn } = scriptedFetch(['hang']);
    const t0 = Date.now();
    const out = await client(fn, { timeoutMs: 40 }).c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("the caller's abort before the request is sent ⇒ aborted, and nothing is sent", async () => {
    // Regression: the abort lands while the key is being resolved, so the combined signal
    // is ALREADY aborted when the attempt starts and no further 'abort' event will fire.
    const { fn, calls } = scriptedFetch(['hang']);
    const ac = new AbortController();
    const pending = client(fn, { timeoutMs: 5000 }).c.decide({ ...choiceRequest, signal: ac.signal });
    ac.abort();
    expect(await pending).toMatchObject({ kind: 'inconclusive', reason: 'aborted' });
    expect(calls).toHaveLength(0);
  });

  it("the caller's abort mid-request ⇒ aborted, distinguishable from a timeout", async () => {
    const { fn, calls } = scriptedFetch(['hang']);
    const ac = new AbortController();
    const pending = client(fn, { timeoutMs: 5000 }).c.decide({ ...choiceRequest, signal: ac.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    ac.abort();
    expect(await pending).toMatchObject({ kind: 'inconclusive', reason: 'aborted' });
  });

  it('the deadline holds even for a transport that ignores its signal', async () => {
    const { fn } = scriptedFetch(['deaf']);
    const t0 = Date.now();
    const out = await client(fn, { timeoutMs: 40 }).c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a request outside documented limits ⇒ invalid-request, and nothing is sent', async () => {
    const { fn, calls } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const out = await client(fn).c.decide({
      state: 's',
      questions: { one: { type: 'score', instructions: 'x', levels: ['only one level'] } },
    });
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });
});

// ── All or nothing ──

describe('malformed 2xx bodies are inconclusive, never partial', () => {
  const cases: Array<[string, unknown]> = [
    ['not JSON', '<html>gateway</html>'],
    ['no model id', { answers: CHOICE_OK.answers }],
    ['a question left unanswered', { model: 'jev-1.13.0', answers: { anger: MIXED_OK.answers.anger } }],
    ['the wrong answer type', { model: 'jev-1.13.0', answers: { ...MIXED_OK.answers, urgent: { type: 'choice', choice: 'yes' } } }],
    [
      'a choice that was never offered',
      { ...CHOICE_OK, answers: { department: { ...CHOICE_OK.answers.department, choice: 'legal' } } },
    ],
    [
      'probabilities that do not sum to 1',
      {
        ...CHOICE_OK,
        answers: { department: { ...CHOICE_OK.answers.department, probabilities: { billing: 0.5, technical: 0.1, sales: 0 } } },
      },
    ],
    [
      'a probability for an unasked option',
      {
        ...CHOICE_OK,
        answers: {
          department: { ...CHOICE_OK.answers.department, probabilities: { billing: 0.8, technical: 0.1, sales: 0, legal: 0.1 } },
        },
      },
    ],
    ['a NaN confidence', { ...CHOICE_OK, answers: { department: { ...CHOICE_OK.answers.department, confidence: 'high' } } }],
  ];

  it.each(cases)('%s ⇒ malformed-response', async (_label, body) => {
    const request = JSON.stringify(body).includes('anger') ? mixedRequest : choiceRequest;
    const { fn } = scriptedFetch([{ status: 200, body }]);
    const out = await client(fn).c.decide(request as DecisionRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'malformed-response' });
  });

  it('a score outside the level range ⇒ malformed-response', async () => {
    const body = { ...MIXED_OK, answers: { ...MIXED_OK.answers, anger: { ...MIXED_OK.answers.anger, score: 2.4 } } };
    const { fn } = scriptedFetch([{ status: 200, body }]);
    expect(await client(fn).c.decide(mixedRequest)).toMatchObject({ kind: 'inconclusive', reason: 'malformed-response' });
  });

  // Falsifiability control (TESTING.md): a lenient parser that accepts whatever answers are
  // present. The SAME predicate that the real adapter satisfies must reject it, proving the
  // all-or-nothing assertion can fail.
  function lenientParse(body: unknown): ProviderParseResult {
    const b = body as { model: string; answers: Record<string, never> };
    return { ok: true, model: b.model, answers: b.answers ?? {}, usage: { inputTokens: null, outputTokens: null } };
  }
  const partial = { model: 'jev-1.13.0', answers: { anger: MIXED_OK.answers.anger } };
  const rejectsPartial = (parse: (b: unknown) => ProviderParseResult) => parse(partial).ok === false;

  it('the real adapter rejects a partially-answered body…', () => {
    const provider = createJevProvider();
    expect(rejectsPartial((b) => provider.parseResponse(b, mixedRequest))).toBe(true);
  });

  it('…and the same check catches the lenient control', () => {
    expect(rejectsPartial(lenientParse)).toBe(false);
  });
});

// ── Retries ──

describe('429 / 529 backoff under one deadline', () => {
  it('retries a 429 with exponential backoff and then answers', async () => {
    const { fn, calls } = scriptedFetch([
      { status: 429, body: {} },
      { status: 529, body: {} },
      { status: 200, body: CHOICE_OK },
    ]);
    const { c, sleeps } = client(fn, { backoffBaseMs: 100, timeoutMs: 5000 });
    const out = await c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'answered', attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('honours Retry-After (seconds) when it fits the budget', async () => {
    const { fn } = scriptedFetch([
      { status: 429, body: {}, retryAfter: '1' },
      { status: 200, body: CHOICE_OK },
    ]);
    const { c, sleeps } = client(fn, { timeoutMs: 5000 });
    await c.decide(choiceRequest);
    expect(sleeps).toEqual([1000]);
  });

  it('gives up as rate-limited once the retry budget is spent', async () => {
    const { fn, calls } = scriptedFetch([{ status: 429, body: { error: 'slow down' } }]);
    const out = await client(fn, { maxRetries: 2, timeoutMs: 5000 }).c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'rate-limited', status: 429, attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  it('does not sleep past the deadline: reports the real 529 instead of a vaguer timeout', async () => {
    const { fn, calls } = scriptedFetch([{ status: 529, body: {} }]);
    const { c, sleeps } = client(fn, { timeoutMs: 50, backoffBaseMs: 1000 });
    const out = await c.decide(choiceRequest);
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'overloaded', attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });
});

// ── Observer (audit ledger seam) ──

describe('call observer', () => {
  it('receives every call with provider, requested model, consumer and outcome', async () => {
    const records: DecisionCallRecord[] = [];
    const { fn } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    await client(fn, { onCall: (r) => void records.push(r) }).c.decide(choiceRequest, { consumer: 'memory-injection' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: 'typesafe',
      requestedModel: JEV_PINNED_MODEL,
      consumer: 'memory-injection',
      subjectIds: [],
      outcome: { kind: 'answered', model: 'jev-1.13.0' },
    });
  });

  it('hands subject ids to the observer and never sends them to the provider', async () => {
    const records: DecisionCallRecord[] = [];
    const { fn, calls } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    await client(fn, { onCall: (r) => void records.push(r) }).c.decide(choiceRequest, {
      consumer: 'memory-injection',
      subjectIds: ['mem-a1', 'mem-b2'],
    });
    expect(records[0]?.subjectIds).toEqual(['mem-a1', 'mem-b2']);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain('mem-a1');
  });

  it('observes inconclusive calls too (a keyless call is still an auditable event)', async () => {
    const records: DecisionCallRecord[] = [];
    const { fn } = scriptedFetch([]);
    await client(fn, { resolveKey: () => null, onCall: (r) => void records.push(r) }).c.decide(choiceRequest);
    expect(records[0]?.outcome).toMatchObject({ kind: 'inconclusive', reason: 'no-key' });
  });

  it('a throwing or rejecting observer never reaches the decision, and a slow one is not awaited', async () => {
    const { fn } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const throwing = await client(fn, {
      onCall: () => {
        throw new Error('ledger down');
      },
    }).c.decide(choiceRequest);
    expect(throwing.kind).toBe('answered');

    const rejecting = await client(fn, { onCall: () => Promise.reject(new Error('ledger down')) }).c.decide(choiceRequest);
    expect(rejecting.kind).toBe('answered');

    let resolveSlow!: () => void;
    const slow = new Promise<void>((r) => (resolveSlow = r));
    const onCall = vi.fn(() => slow);
    const out = await client(fn, { onCall }).c.decide(choiceRequest);
    expect(out.kind).toBe('answered');
    expect(onCall).toHaveBeenCalledTimes(1);
    resolveSlow();
  });
});

// ── Host load (P-001: was a timeout the provider's fault or ours?) ──

/** Burn the calling thread synchronously, like a spawn() or a sync file read does. */
function blockThread(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

describe('host load on the observed record', () => {
  it('starts the meter before the request and ends it after the outcome, recording its value', async () => {
    const order: string[] = [];
    const records: DecisionCallRecord[] = [];
    const { fn: inner } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const fn: FetchLike = (url, init) => {
      order.push('fetch');
      return inner(url, init);
    };
    await client(fn, {
      onCall: (r) => void records.push(r),
      hostLoad: () => {
        order.push('start');
        return () => {
          order.push('end');
          return { busyMs: 42, utilization: 0.6 };
        };
      },
    }).c.decide(choiceRequest);
    expect(order).toEqual(['start', 'fetch', 'end']);
    expect(records[0]?.hostLoad).toEqual({ busyMs: 42, utilization: 0.6 });
  });

  it('hostLoad: null turns the measurement off and records null', async () => {
    const records: DecisionCallRecord[] = [];
    const { fn } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    await client(fn, { hostLoad: null, onCall: (r) => void records.push(r) }).c.decide(choiceRequest);
    expect(records[0]?.hostLoad).toBeNull();
  });

  it('a meter that throws at start or at end never reaches the decision; it records null', async () => {
    const { fn } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const records: DecisionCallRecord[] = [];
    const atStart = await client(fn, {
      onCall: (r) => void records.push(r),
      hostLoad: () => {
        throw new Error('meter broke');
      },
    }).c.decide(choiceRequest);
    const atEnd = await client(fn, {
      onCall: (r) => void records.push(r),
      hostLoad: () => () => {
        throw new Error('meter broke');
      },
    }).c.decide(choiceRequest);
    expect([atStart.kind, atEnd.kind]).toEqual(['answered', 'answered']);
    expect(records.map((r) => r.hostLoad)).toEqual([null, null]);
  });

  it('default meter: an answer held up by a busy thread records high utilization', async () => {
    const records: DecisionCallRecord[] = [];
    const { fn: inner } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const busy: FetchLike = async (url, init) => {
      const res = await inner(url, init);
      blockThread(120); // the answer is here, but the thread is busy elsewhere
      return res;
    };
    await client(busy, { onCall: (r) => void records.push(r) }).c.decide(choiceRequest);
    const load = records[0]?.hostLoad;
    expect(load).not.toBeNull();
    expect(load!.busyMs).toBeGreaterThanOrEqual(100);
    expect(load!.utilization).toBeGreaterThan(0.5);
  });

  it('default meter: a call that waits idle on the network records low utilization', async () => {
    const records: DecisionCallRecord[] = [];
    const { fn: inner } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    const slowProvider: FetchLike = async (url, init) => {
      await new Promise((r) => setTimeout(r, 200)); // the provider is slow; the thread is idle
      return inner(url, init);
    };
    await client(slowProvider, { onCall: (r) => void records.push(r) }).c.decide(choiceRequest);
    const load = records[0]?.hostLoad;
    expect(load).not.toBeNull();
    // Positive control for the comparison: the call really did span the 200 ms wait.
    expect(records[0]!.outcome.latencyMs).toBeGreaterThanOrEqual(190);
    expect(load!.utilization).toBeLessThan(0.5);
    expect(load!.busyMs).toBeLessThan(100);
  });
});

// ── Host seam ──

describe('configureDecisionModel seam', () => {
  it('with no configured client, decide() is inconclusive(not-configured) rather than throwing', async () => {
    configureDecisionModel(null);
    expect(getDecisionClient()).toBeNull();
    expect(await decide(choiceRequest)).toMatchObject({ kind: 'inconclusive', reason: 'not-configured' });
  });

  it('routes decide() through the configured client', async () => {
    const { fn, calls } = scriptedFetch([{ status: 200, body: CHOICE_OK }]);
    configureDecisionModel(client(fn).c);
    const out = await decide(choiceRequest);
    expect(out.kind).toBe('answered');
    expect(calls).toHaveLength(1);
  });
});

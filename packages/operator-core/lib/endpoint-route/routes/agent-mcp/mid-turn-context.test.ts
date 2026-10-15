/**
 * mid-turn-context.test.ts — the MID-TURN injection endpoint
 * (context-injection-audit-2026-07-28 P-015 / D-026).
 *
 * The load-bearing cases here are the COST ones. This endpoint is called before
 * every investigation-shaped tool dispatch in every psu session on the box, so
 * its failure mode is not "returns the wrong text" — it is "quietly costs the
 * whole fleet an embed per tool call, or floods a fifty-call turn with 200k
 * chars of context". Three properties keep that from happening, and each has a
 * test below that fails if someone removes it:
 *
 *   - the budget stays an order of magnitude under turn-start's 4000;
 *   - the port stays 'mid-turn', so the port-agnostic epoch ledger (D-006)
 *     dedups it against turn-start/orient/initialize FOR FREE — the reason
 *     P-017 must not grow a second dedup;
 *   - a tool call carrying no recall signal spends NOTHING.
 *
 * The acceptance case (P-018) is the last describe block: the push must fire on
 * the FIRST grep for a symptom, because that is the call that saves the other
 * nineteen. A time-based throttle would have suppressed exactly that, which is
 * why the rate guard is a rolling ceiling rather than a min-interval.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  buildMemoryContextBlockMock,
  withMidTurnMemoryAdmissionMock,
  recordInjectionCoverageMock,
  resolveClaimedWorkItemIdForOwnerMock,
  takePendingFailureLoopHintMock,
  buildFailureLoopHintTextMock,
  evaluateHookContextSinkMock,
} = vi.hoisted(() => ({
  buildMemoryContextBlockMock: vi.fn(),
  withMidTurnMemoryAdmissionMock: vi.fn(),
  recordInjectionCoverageMock: vi.fn(),
  resolveClaimedWorkItemIdForOwnerMock: vi.fn(),
  takePendingFailureLoopHintMock: vi.fn(),
  buildFailureLoopHintTextMock: vi.fn(),
  evaluateHookContextSinkMock: vi.fn(),
}));

// Same relative specifiers the source's dynamic imports use (colocated).
vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: buildMemoryContextBlockMock,
}));
vi.mock('../../../memory/injection-delivery-coverage', () => ({
  recordInjectionCoverage: recordInjectionCoverageMock,
}));
vi.mock('../../../memory/mid-turn-admission', () => ({
  withMidTurnMemoryAdmission: withMidTurnMemoryAdmissionMock,
}));
vi.mock('../../../memory/agent-signals', () => ({
  resolveClaimedWorkItemIdForOwner: resolveClaimedWorkItemIdForOwnerMock,
}));
vi.mock('../../../failure-loop-circuit-breaker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../failure-loop-circuit-breaker')>()),
  takePendingFailureLoopHint: takePendingFailureLoopHintMock,
}));
vi.mock('../../../failure-loop-hints', () => ({
  buildFailureLoopHintText: buildFailureLoopHintTextMock,
}));
vi.mock('../../../agent-identities/sync-hook-rules', () => ({
  evaluateHookContextSink: evaluateHookContextSinkMock,
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'u-1' }) }));

import routes, {
  deriveQuery,
  deriveBatchQuery,
  deriveQueryDetailed,
  deriveBatchQueryDetailed,
  TOOL_QUERY_VOCABULARY,
  clampToBudget,
  composeMidTurnContextText,
  splitLegQueries,
} from './mid-turn-context';
import { CORPUS_BLOCK_HEADING } from '../../../memory/corpus-recall';
import { setSessionConfinementResolver } from '../../../capability-envelope/session-confinement-port';

const endpoint = routes[0] as unknown as {
  handler: (req: Request) => Promise<Response>;
};

const post = async (body: unknown): Promise<{ ok: boolean; text: string }> => {
  const res = await endpoint.handler(
    new Request('http://localhost/agent-mcp/mid-turn-context', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as { ok: boolean; text: string };
};

it('suppresses live mid-turn memory, rule and failure-hint delivery for a frozen native session', async () => {
  setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: ['coord:whoami'],
    denyAmbientContext: true, reason: 'frozen benchmark', imposedBy: 'host' }));
  try {
    expect(await post({ owner: 'su-frozen', workspace: 'private', tool: 'Read', toolInput: { file_path: 'code.ts' } })).toEqual({ ok: true, text: '' });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(evaluateHookContextSinkMock).not.toHaveBeenCalled();
    expect(takePendingFailureLoopHintMock).not.toHaveBeenCalled();
  } finally { setSessionConfinementResolver(undefined); }
});

/** Each test gets a fresh session id — the rate/dedup state is keyed by owner. */
let seq = 0;
const owner = (): string => `sess-${++seq}`;

const firstCall = () => buildMemoryContextBlockMock.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  setSessionConfinementResolver(() => null);
  buildMemoryContextBlockMock.mockReset().mockResolvedValue('MEM');
  withMidTurnMemoryAdmissionMock
    .mockReset()
    .mockImplementation(async (run: () => Promise<unknown>) => ({ admitted: true, value: await run() }));
  recordInjectionCoverageMock.mockReset();
  resolveClaimedWorkItemIdForOwnerMock.mockReset().mockResolvedValue(undefined);
  takePendingFailureLoopHintMock.mockReset().mockReturnValue(null);
  buildFailureLoopHintTextMock.mockReset().mockResolvedValue('FAILURE LOOP HINT');
  evaluateHookContextSinkMock.mockReset().mockResolvedValue({ text: '', result: null });
});

it('charges identity preparation to the native response wall before starting the memory builder', async () => {
  resolveClaimedWorkItemIdForOwnerMock.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    return undefined;
  });
  const began = Date.now();
  const result = await post({ owner: owner(), workspace: 'ws-test',
    tool: 'Grep', toolInput: { pattern: 'diagnostic evidence' }, wallMs: 1000 });
  const input = firstCall() as { deadline?: { remainingMs(): number }; respondByMs?: number };
  expect(result.text).toBe('MEM');
  expect(input.respondByMs).toBeGreaterThanOrEqual(began + 750);
  expect(input.respondByMs).toBeLessThanOrEqual(began + 780);
  expect(input.deadline?.remainingMs()).toBeLessThan(700);
  expect(input.deadline?.remainingMs()).toBeGreaterThan(0);
});

it('preserves the existing memory budget when the caller declares no native response wall', async () => {
  await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'diagnostic evidence' } });
  expect(firstCall()).not.toHaveProperty('deadline');
  expect(firstCall()).not.toHaveProperty('respondByMs');
});

/** Every coverage event recorded this test, flattened across calls. */
const coverageEvents = (): Array<Record<string, unknown>> =>
  recordInjectionCoverageMock.mock.calls.flatMap((call) => (call[0] ?? []) as Array<Record<string, unknown>>);

describe('mid-turn-context — query derivation', () => {
  it("reads a Bash call as its command plus the agent's own description", () => {
    expect(deriveQuery('Bash', { command: 'rg WI-6512 packages', description: 'find the bug' })).toBe(
      'rg WI-6512 packages — find the bug',
    );
  });

  it('reads a Grep call as pattern + where it is looking', () => {
    expect(deriveQuery('Grep', { pattern: 'buildMemoryContextBlock', path: 'packages' })).toBe(
      'buildMemoryContextBlock packages',
    );
  });

  it('reads a Read call as the path', () => {
    expect(deriveQuery('Read', { file_path: '/a/b/injection.ts' })).toBe('/a/b/injection.ts');
  });

  it('yields NOTHING for a tool with no recall signal — so it can be dropped before any spend', () => {
    // Returning '' here is what makes a signal-free call FREE rather than
    // embedding a blob of JSON. Both miss kinds must short-circuit:
    expect(deriveQuery('TodoWrite', { todos: [] })).toBe(''); // unknown-tool
    expect(deriveQuery('AskUserQuestion', { questions: [] })).toBe(''); // no-signal
    // ⚠ This case used `Edit` until WI-37587, when Edit/Write were mapped to
    // `file_path` (they carry the same signal as Read — 581 Edit calls/day were
    // being dropped). Do not reintroduce a MAPPED tool as the example here.
  });
});

describe('mid-turn-context — batch folding (the PostToolBatch payload)', () => {
  it('folds a batch newest-FIRST — the tail of a batch is the freshest intent', () => {
    const q = deriveBatchQuery([
      { tool: 'Read', toolInput: { file_path: '/old.ts' }, toolResponse: 'contents' },
      { tool: 'Grep', toolInput: { pattern: 'newest' }, toolResponse: 'a hit' },
    ]);
    expect(q.indexOf('newest')).toBeLessThan(q.indexOf('/old.ts'));
  });

  it('marks a BARREN result — the strongest "about to re-derive something" signal there is', () => {
    // Only available because this fires AFTER the tools ran. A grep that found
    // nothing is exactly when recall is most valuable.
    expect(
      deriveBatchQuery([{ tool: 'Grep', toolInput: { pattern: 'WI-6512' }, toolResponse: 'No matches found' }]),
    ).toContain('(no result)');
    expect(
      deriveBatchQuery([{ tool: 'Grep', toolInput: { pattern: 'WI-6512' }, toolResponse: 'packages/a.ts:12: hit' }]),
    ).not.toContain('(no result)');
  });

  it('accepts the CLAMPED string tool_input the hook actually sends', () => {
    // The hook JSON-stringifies and clamps before POSTing, so the server must
    // parse that back rather than assuming a structured object.
    expect(deriveQuery('Grep', JSON.stringify({ pattern: 'abc', path: 'packages' }))).toBe('abc packages');
  });

  it('falls back to raw text when a clamp truncated the JSON mid-way', () => {
    expect(deriveQuery('Bash', '{"command":"rg WI-65')).toContain('rg WI-65');
  });

  it('drops a batch whose calls carry no recall signal at all', async () => {
    const out = await post({
      owner: owner(),
      // A signal-free tool (see the derive test above — NOT a mapped one).
      toolCalls: [{ tool: 'TodoWrite', toolInput: { todos: [] }, toolResponse: 'ok' }],
    });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(out.text).toBe('');
  });

  it('runs the pipeline once for the whole batch, not once per call', async () => {
    await post({
      owner: owner(),
      toolCalls: [
        { tool: 'Grep', toolInput: { pattern: 'alpha' }, toolResponse: 'x' },
        { tool: 'Grep', toolInput: { pattern: 'beta' }, toolResponse: 'y' },
        { tool: 'Read', toolInput: { file_path: '/c.ts' }, toolResponse: 'z' },
      ],
      harness: 'papercusp',
    });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(firstCall()).toMatchObject({ session: { port: 'mid-turn' } });
  });
});

describe('mid-turn-context — the cost properties', () => {
  it('spends NOTHING on a tool call with no recall signal', async () => {
    // A signal-free tool (see the derive test above — NOT a mapped one).
    const out = await post({ owner: owner(), tool: 'TodoWrite', toolInput: { todos: [] } });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(out.text).toBe('');
  });

  it("uses a budget an ORDER OF MAGNITUDE under turn-start's 4000", async () => {
    // The arithmetic that matters: at turn-start's budget a 50-call turn would
    // inject ~200k chars. If this assertion is ever "fixed" by raising the
    // budget, re-do that arithmetic first.
    await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'deploy pipeline' } });
    const { budgetChars } = firstCall() as { budgetChars: number };
    expect(budgetChars).toBeLessThanOrEqual(400);
    expect(budgetChars * 50).toBeLessThan(4_000 * 50 * 0.2);
  });

  it('passes port "mid-turn" so the epoch ledger dedups it against every other port for free', async () => {
    // D-006: the ledger is port-agnostic. This is the whole reason P-017 needs
    // no dedup of its own — do not add a second one.
    await post({ owner: 'sess-port', tool: 'Grep', toolInput: { pattern: 'x' }, harness: 'papercusp' });
    expect(firstCall()).toMatchObject({
      session: { sessionId: 'sess-port', port: 'mid-turn' },
      harnessSlugs: ['papercusp'],
    });
  });

  it('passes the active work-item scope so related pointers are visibly disambiguated', async () => {
    resolveClaimedWorkItemIdForOwnerMock.mockResolvedValue('WI-38148');
    await post({ owner: 'sess-scope', tool: 'Grep', toolInput: { pattern: 'grader' } });

    expect(resolveClaimedWorkItemIdForOwnerMock).toHaveBeenCalledWith({
      ownerId: 'sess-scope',
      workspaceId: 'ws-test',
    });
    expect(firstCall()).toMatchObject({
      session: { sessionId: 'sess-scope', port: 'mid-turn', currentWorkItemId: 'WI-38148' },
    });
  });

  it('skips an IDENTICAL consecutive query for free — a retry loop costs one embed, not N', async () => {
    const o = owner();
    const call = { owner: o, tool: 'Bash', toolInput: { command: 'npm test' } };
    await post(call);
    await post(call);
    await post(call);
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
  });

  it('caps recalls per rolling minute so a burst cannot buy an embed each', async () => {
    const o = owner();
    for (let i = 0; i < 40; i++) {
      await post({ owner: o, tool: 'Grep', toolInput: { pattern: `distinct-${i}` } });
    }
    // Every query is distinct, so only the rolling ceiling can bound this.
    expect(buildMemoryContextBlockMock.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('returns empty without starting recall when the host-wide admission is full', async () => {
    withMidTurnMemoryAdmissionMock.mockResolvedValueOnce({
      admitted: false,
      reason: 'at_capacity',
    });
    const out = await post({
      owner: owner(),
      tool: 'Grep',
      toolInput: { pattern: 'optional recall under fleet burst' },
    });
    expect(out).toEqual({ ok: true, text: '' });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
  });

  it('clamps a very long command rather than embedding a pasted heredoc', async () => {
    await post({ owner: owner(), tool: 'Bash', toolInput: { command: 'x'.repeat(5_000) } });
    // The clamp applies to the DERIVED text, before the P-044 per-leg split, so
    // both halves inherit it — neither leg can be handed a pasted heredoc.
    const { queryContext } = firstCall() as {
      queryContext: { userText: string; lexicalText: string };
    };
    expect(queryContext.userText).toHaveLength(1_000);
    expect(queryContext.lexicalText).toHaveLength(1_000);
  });
});

describe('mid-turn-context — never breaks a turn', () => {
  it('fail-soft: a throwing memory pipeline never surfaces an error into the tool call', async () => {
    buildMemoryContextBlockMock.mockRejectedValue(new Error('backend down'));
    const out = await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'storage policy' } });
    expect(out.ok).toBe(true);
    expect(out.text).toBe('');
  });

  it('returns empty rather than null when the pipeline finds nothing relevant', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const out = await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'nothing here' } });
    expect(out.text).toBe('');
  });

  it('requires an owner', async () => {
    const res = await endpoint.handler(
      new Request('http://localhost/agent-mcp/mid-turn-context', {
        method: 'POST',
        body: JSON.stringify({ tool: 'Grep', toolInput: { pattern: 'x' } }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('survives a malformed body', async () => {
    const res = await endpoint.handler(
      new Request('http://localhost/agent-mcp/mid-turn-context', { method: 'POST', body: 'not json' }),
    );
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('mid-turn-context — EI-6139 failure-loop bridge', () => {
  const pending = {
    ownerId: 'sess-loop',
    toolName: 'docs:get',
    argsShape: 'shape',
    errorClass: 'refused:harness_required',
    count: 3,
    detectedAt: Date.now(),
  };

  it('composes the pending intervention with ordinary recalled context', async () => {
    takePendingFailureLoopHintMock.mockReturnValueOnce(pending);
    const out = await post({
      owner: 'sess-loop',
      tool: 'Grep',
      toolInput: { pattern: 'harness required' },
    });
    expect(buildFailureLoopHintTextMock).toHaveBeenCalledWith(pending);
    expect(out.text).toBe('FAILURE LOOP HINT\n\nMEM');
  });

  it('drains detector state by the private key, not the public recall owner', async () => {
    takePendingFailureLoopHintMock.mockReturnValueOnce(pending);
    const out = await post({
      owner: 'harness:papercusp',
      detectorSessionKey: 'auditor-session-a',
      tool: 'Grep',
      toolInput: { pattern: 'harness required' },
    });
    expect(takePendingFailureLoopHintMock).toHaveBeenCalledWith('auditor-session-a');
    expect(out.text).toBe('FAILURE LOOP HINT\n\nMEM');
  });

  it('delivers the intervention when a no-signal batch exits before recall', async () => {
    takePendingFailureLoopHintMock.mockReturnValueOnce(pending);
    const out = await post({
      owner: 'sess-loop-no-signal',
      tool: 'TodoWrite',
      toolInput: { todos: [] },
    });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(out.text).toBe('FAILURE LOOP HINT');
  });

  it('delivers the intervention when host-wide recall admission is full', async () => {
    takePendingFailureLoopHintMock.mockReturnValueOnce(pending);
    withMidTurnMemoryAdmissionMock.mockResolvedValueOnce({
      admitted: false,
      reason: 'at_capacity',
    });
    const out = await post({
      owner: 'sess-loop-at-capacity',
      tool: 'Grep',
      toolInput: { pattern: 'harness required' },
    });
    expect(out.text).toBe('FAILURE LOOP HINT');
  });

  it('keeps the failure, rule and memory budgets independent when composing', () => {
    expect(composeMidTurnContextText('MEMORY', 'FAILURE', 'RULES')).toBe('FAILURE\n\nRULES\n\nMEMORY');
    expect(composeMidTurnContextText('MEMORY', '', '')).toBe('MEMORY');
  });
});

describe('mid-turn-context — worn post-tool rules (portable-identity-packages P-011)', () => {
  it("evaluates the post-tool sink with the batch's tool names and delivers its text", async () => {
    evaluateHookContextSinkMock.mockResolvedValueOnce({ text: 'RULE CONTEXT', result: null });
    const out = await post({
      owner: 'sess-rules-batch',
      workspace: 'ws-rules',
      toolCalls: [
        { tool: 'Grep', toolInput: { pattern: 'harness required' } },
        { tool: ' mcp__papercusp-su__coord_whoami ', toolInput: {} },
        { toolInput: {} },
      ],
    });
    expect(evaluateHookContextSinkMock).toHaveBeenCalledTimes(1);
    expect(evaluateHookContextSinkMock.mock.calls[0]![0]).toMatchObject({
      ownerId: 'sess-rules-batch',
      workspaceId: 'ws-rules',
      sink: 'post-tool',
      tools: ['Grep', 'mcp__papercusp-su__coord_whoami'],
    });
    expect(evaluateHookContextSinkMock.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(out.text).toBe('RULE CONTEXT\n\nMEM');
  });

  it('delivers the rule text when a no-signal call exits before recall', async () => {
    evaluateHookContextSinkMock.mockResolvedValueOnce({ text: 'RULE CONTEXT', result: null });
    const out = await post({ owner: 'sess-rules-no-signal', tool: 'TodoWrite', toolInput: { todos: [] } });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(evaluateHookContextSinkMock.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws-test', tools: ['TodoWrite'] });
    expect(out.text).toBe('RULE CONTEXT');
  });

  it('fails open: a throwing sink costs the batch its rules, never its recall', async () => {
    evaluateHookContextSinkMock.mockRejectedValueOnce(new Error('store down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await post({ owner: 'sess-rules-throw', tool: 'Grep', toolInput: { pattern: 'harness required' } });
    expect(out.text).toBe('MEM');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mid-turn:post-tool-rules failed: store down'));
    warn.mockRestore();
  });

  it('fails open inside the wall: a sink that never settles still lets recall through', async () => {
    evaluateHookContextSinkMock.mockReturnValueOnce(new Promise(() => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const out = await post({ owner: 'sess-rules-hang', tool: 'Grep', toolInput: { pattern: 'harness required' } });
    expect(out.text).toBe('MEM');
    expect(Date.now() - started).toBeLessThan(1400);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mid-turn:post-tool-rules exceeded 1000ms'));
    warn.mockRestore();
  });

  it('does not evaluate the sink for a request that names no tool', async () => {
    await post({ owner: 'sess-rules-none', toolCalls: [{ toolInput: {} }] });
    expect(evaluateHookContextSinkMock).not.toHaveBeenCalled();
  });
});

describe('mid-turn-context — P-018 acceptance: fires EARLY, on the first grep', () => {
  it('injects on the FIRST investigation call, not after a warm-up', async () => {
    // The founding case: an su spent ~20 calls re-deriving WI-6512, a bug
    // already documented in three docstrings. The push has to land on call one —
    // that is the call that saves the other nineteen.
    const out = await post({
      owner: owner(),
      tool: 'Grep',
      toolInput: { pattern: 'WI-6512', path: 'packages' },
      harness: 'papercusp',
    });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(out.text).toBe('MEM');
    // P-044: the derived signal is still `WI-6512 packages`, but it is now
    // issued as two per-leg queries. `packages` is a bare directory with no
    // slash, so nothing is strippable here and both halves are the whole text —
    // the id, which is what this acceptance case is actually about, reaches
    // BOTH legs exactly as before.
    expect(firstCall()).toMatchObject({
      queryContext: { userText: 'WI-6512 packages', lexicalText: 'WI-6512 packages' },
    });
  });
});

describe('mid-turn-context — the budget is enforced HERE, because injection.ts does not', () => {
  // THE DEFECT THIS PINS (found by running the P-018 acceptance case against live
  // retrieval, not by reading the code): buildMemoryContextBlock treats budgetChars
  // as advisory for the FIRST row. Its admit() is
  //     if (spent + line.length > budget && lines.length > 0) return false;
  // so row one is emitted whole at any size — deliberate there (a small-budget
  // caller should get something rather than null), wrong here. Measured against the
  // real store, the top-ranked record for the acceptance query is ~3,700 chars
  // against this endpoint's 350. Since this fires per tool BATCH, an unclamped
  // endpoint reintroduces exactly the context flood the 350 budget exists to
  // prevent — and the epoch dedup does NOT save us, because it bounds the repeat
  // of ONE record, not the size of fifty distinct ones.
  const OVERSIZED = `## Possibly relevant (mid-turn)\n\n- [project @ papercusp] (id=980ce692) ${'x'.repeat(4000)}`;

  it('clamps a single oversized row that buildMemoryContextBlock emitted whole', async () => {
    buildMemoryContextBlockMock.mockResolvedValueOnce(OVERSIZED);
    const out = await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'slow session history' } });
    // Generously under the raw block, and near the 350 budget rather than 10x it.
    expect(out.text.length).toBeLessThan(500);
    expect(OVERSIZED.length).toBeGreaterThan(4000);
  });

  it('keeps the memory id when clipping without prescribing a possibly unavailable tool', async () => {
    buildMemoryContextBlockMock.mockResolvedValueOnce(OVERSIZED);
    const out = await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'slow session history' } });
    expect(out.text).toContain('id=980ce692');
    expect(out.text).toContain('(clipped; id retained)');
    expect(out.text).not.toContain('memory:search');
  });

  it('leaves a block already within budget byte-identical', () => {
    const small = '## Possibly relevant (mid-turn)\n\n- [project] (id=abc) short and useful';
    expect(clampToBudget(small)).toBe(small);
  });

  it('never throws on an empty block', () => {
    expect(clampToBudget('')).toBe('');
  });

  it('cuts at a word boundary when one is available, not mid-token', () => {
    const block = `${'word '.repeat(100)}TAIL`;
    const out = clampToBudget(block, 120);
    const head = out.split(' … ')[0]!;
    expect(head.endsWith('word')).toBe(true);
  });

  // WI-6857 CUT 2. The clamp is a repair for the mem0 leg's UNENFORCED budget
  // (see the OVERSIZED comment above), and it was being applied to the whole
  // composed block — so the corpus excerpt section composeWithCorpus appends
  // LAST was deleted on every call. Measured live: 21 of 21 calls returned
  // 398-403 chars, i.e. this budget plus the clip suffix, never an excerpt.
  // The corpus leg enforces CORPUS_BUDGET_CHARS strictly (no first-row
  // exemption — WI-6870), so it arrives already bounded.
  const EXCERPT = '- [work-item WI-6512 · 2026-07-27] clicking an agent takes several seconds';
  const CORPUS = `### ${CORPUS_BLOCK_HEADING}\n\n${EXCERPT}`;

  it('does NOT clamp the corpus excerpt section away — it is bounded by its own leg', () => {
    const block = `## Possibly relevant (mid-turn)\n\n- [project] (id=abc) ${'x'.repeat(4000)}\n\n${CORPUS}`;
    const out = clampToBudget(block);
    expect(out).toContain('WI-6512');
    expect(out).toContain('clicking an agent takes several seconds');
    expect(out.endsWith(EXCERPT)).toBe(true);
  });

  it('still clamps the mem0 half when a corpus section follows it', () => {
    const block = `## Possibly relevant (mid-turn)\n\n- [project] (id=abc) ${'x'.repeat(4000)}\n\n${CORPUS}`;
    const out = clampToBudget(block);
    const mem0 = out.slice(0, out.indexOf(`\n\n### ${CORPUS_BLOCK_HEADING}`));
    expect(mem0).toContain('(clipped');
    expect(mem0.length).toBeLessThan(500);
  });

  it('leaves a corpus-only block whole — the mem0 leg having nothing is P-008s motivating case', () => {
    const block = `## ${CORPUS_BLOCK_HEADING}\n\n${EXCERPT.repeat(6)}`;
    expect(clampToBudget(block)).toBe(block);
  });

  it('never truncates a matched excerpt mid-line', () => {
    const block = `## Possibly relevant (mid-turn)\n\n- [project] (id=abc) ok\n\n${CORPUS}`;
    const out = clampToBudget(block, 20);
    for (const line of out.split('\n').filter((l) => l.startsWith('- [work-item'))) {
      expect(line.endsWith('seconds')).toBe(true);
    }
  });
});

describe('splitLegQueries — de-diluting the cosine query (P-044 / F-L, motivated by D-041)', () => {
  it('strips path tokens from the COSINE half and keeps the LEXICAL half whole', () => {
    // D-041's batch one, in shape: four content words carrying a directory path
    // twice plus a full component path. The cosine leg embeds ONE vector, so
    // those tokens were pulling it toward "files under apps/operator-vite".
    const derived =
      'session history slow apps/operator-vite/src · apps/operator-vite/src/components/HistoryDropdown.tsx';
    const { cosine, lexical } = splitLegQueries(derived);
    // No trailing `·`: the second segment was nothing BUT a path, so its
    // separator is debris once the path is gone (WI-6857).
    expect(cosine).toBe('session history slow');
    expect(lexical).toBe(derived);
  });

  it('sweeps the separator + "(no result)" debris the strip leaves behind (WI-6857)', () => {
    // The WI-6512 replay's batch 63, verbatim: a barren Grep, a Read that is
    // pure path, and a Grep carrying its own path. Before the sweep the cosine
    // query was `session history (no result) · · agents running` — 46 chars of
    // which ~28% was residue this function had already judged non-prose.
    const derived = deriveBatchQuery([
      {
        tool: 'Grep',
        toolInput: { pattern: 'agents running', path: 'apps/operator-vite/src' },
        toolResponse: 'apps/operator-vite/src/components/adv/AgentsRunningPill.tsx',
      },
      {
        tool: 'Read',
        toolInput: { file_path: 'apps/operator-vite/src/components/adv/AgentsRunningPill.tsx' },
        toolResponse: 'export function AgentsRunningPill() { … }',
      },
      {
        tool: 'Grep',
        toolInput: { pattern: 'session history', path: 'apps/operator-vite/src' },
        toolResponse: 'No matches found',
      },
    ]);
    const { cosine, lexical } = splitLegQueries(derived);
    expect(cosine).toBe('session history · agents running');
    // The LEXICAL leg is byte-identical to the derived text — it keeps the
    // paths AND the barren marker, both of which it can actually use.
    expect(lexical).toBe(derived);
    expect(lexical).toContain('(no result)');
  });

  it('strips an absolute path and a single-slash path that carries an extension', () => {
    expect(splitLegQueries('why empty /home/x/repo/lib/a.ts').cosine).toBe('why empty');
    expect(splitLegQueries('why empty memory/injection.ts').cosine).toBe('why empty');
  });

  it('strips a path bounded by SHELL PUNCTUATION, not just whitespace (WI-37403)', () => {
    // REGRESSION GUARD. The boundaries were `(?:^|\s)` … `(?=\s|$)`, which is
    // right for prose and wrong for this port's dominant input — a Bash
    // tool_input, where paths sit against punctuation constantly. Every case
    // below is a real command shape that the whitespace-only boundary MISSED,
    // leaving the path in the cosine query to pull the vector (D-041).
    //
    // The first one is the measured original: it injected two memories whose
    // only tie to the task was the token `linuxbrew`.
    expect(
      splitLegQueries('resolve hook events B=$(readlink -f /home/linuxbrew/.linuxbrew/bin/codex); echo bin').cosine,
    ).not.toMatch(/linuxbrew/);

    // `);`  `"`  `|`  — closing paren + semicolon, quotes, and a pipe.
    expect(splitLegQueries('why empty $(cat /home/x/repo/lib/a.ts); done').cosine).toBe('why empty $(cat ); done');
    expect(splitLegQueries('why empty "/home/x/repo/lib/a.ts"').cosine).toBe('why empty " "');
    expect(splitLegQueries('why empty memory/injection.ts|head').cosine).toBe('why empty |head');
  });

  it('LEAVES prose that merely contains a slash — where the false positives live', () => {
    // `and/or`, `input/output`, `24/7` are things an agent really does type into
    // a Grep pattern or a Bash description; stripping them would delete meaning
    // from the very query this is protecting.
    for (const text of ['check the and/or branch', 'the input/output split', 'runs 24/7']) {
      expect(splitLegQueries(text).cosine).toBe(text);
    }
  });

  it('FALLS BACK to the full text when stripping leaves no prose — the load-bearing case', () => {
    // A Read-only batch is nothing but paths. buildMemoryContextBlock gates on
    // the COSINE text being non-empty, so returning '' here would silently
    // disable mid-turn recall for every path-only batch — a far larger
    // regression than the dilution this fixes. And with no prose present there
    // is nothing to dilute, so keeping the full text costs nothing.
    const derived = deriveBatchQuery([
      { tool: 'Read', toolInput: { file_path: 'packages/operator-core/lib/memory/injection.ts' }, toolResponse: 'x' },
    ]);
    const { cosine, lexical } = splitLegQueries(derived);
    expect(cosine).toBe(derived);
    expect(lexical).toBe(derived);
  });

  it('treats a "(no result)" marker as chrome, not as the prose worth keeping', () => {
    // Otherwise a barren path-only batch reads as "has words" and the cosine
    // query becomes the literal string "(no result)".
    const derived = deriveBatchQuery([
      { tool: 'Glob', toolInput: { pattern: 'apps/**/Foo.tsx' }, toolResponse: 'No files found' },
    ]);
    expect(splitLegQueries(derived).cosine).toBe(derived);
  });

  it('is a no-op on a query with no paths at all', () => {
    const derived = 'why does session history take several seconds to load';
    expect(splitLegQueries(derived)).toEqual({ cosine: derived, lexical: derived });
  });

  it('the endpoint sends the two halves to the two legs', async () => {
    buildMemoryContextBlockMock.mockResolvedValueOnce('## Possibly relevant (mid-turn)\n\n- hit');
    await post({
      owner: owner(),
      toolCalls: [
        {
          tool: 'Grep',
          toolInput: { pattern: 'session history slow', path: 'apps/operator-vite/src' },
          toolResponse: 'No matches found',
        },
      ],
    });
    const arg = buildMemoryContextBlockMock.mock.calls[0]![0] as {
      queryContext: { userText: string; lexicalText: string };
    };
    expect(arg.queryContext.userText).not.toContain('apps/operator-vite/src');
    expect(arg.queryContext.userText).toContain('session history slow');
    expect(arg.queryContext.lexicalText).toContain('apps/operator-vite/src');
  });
});

/**
 * THE SHARED TOOL VOCABULARY (codex-context-injection-parity-2026-08-09, D-005).
 *
 * Before this, deriveQuery switched on Claude's four PascalCase names with
 * `default: return ''`, and the handler drops an empty derive BEFORE both the
 * recall and the stats write. So mid-turn context for codex and omp was not
 * degraded — it was STRUCTURALLY IMPOSSIBLE, and not even recorded as a miss.
 *
 * Two properties are asserted here, and the second is the one that keeps this
 * from silently rotting again:
 *   1. every client's real vocabulary derives a query;
 *   2. a miss says WHICH KIND it is — an unmapped tool (drift, actionable) vs a
 *      known tool carrying no signal (expected quiet, not actionable).
 *
 * The tool names below are MEASURED, not invented: codex's from 4,131 tool-call
 * records in ~/.codex/sessions, omp's from ~/.omp plus the shipped schemas in
 * @oh-my-pi/pi-coding-agent. A test written against guessed names would pass
 * against a guessed implementation and prove nothing.
 */
describe('shared tool vocabulary — codex + omp parity (D-005)', () => {
  describe('claude behaviour is unchanged (D-003 equivalence must survive)', () => {
    // Claude is ~100% of current traffic, so a regression here is a net loss
    // even if every new client works perfectly.
    it('Bash still joins command and description with the em-dash separator', () => {
      expect(deriveQuery('Bash', { command: 'rg foo', description: 'find foo' })).toBe('rg foo — find foo');
    });
    it('Grep/Glob/Read keep their exact field order and space separator', () => {
      expect(deriveQuery('Grep', { pattern: 'p', path: 'a/b', glob: '*.ts' })).toBe('p a/b *.ts');
      expect(deriveQuery('Glob', { pattern: 'p', path: 'a/b' })).toBe('p a/b');
      expect(deriveQuery('Read', { file_path: '/x/y.ts' })).toBe('/x/y.ts');
    });
  });

  describe('codex (snake_case)', () => {
    it('derives from exec_command — the dominant codex tool (3034/4131 calls)', () => {
      const q = deriveQuery('exec_command', {
        cmd: "rg --files -g '*.prisma'",
        workdir: '/home/x/Restart',
      });
      expect(q).toContain("rg --files -g '*.prisma'");
      expect(q).toContain('/home/x/Restart');
    });
    it('derives from apply_patch, which arrives as a FREEFORM non-JSON string', () => {
      // custom_tool_call: `input` is a raw patch body, never JSON. Under the old
      // JSON-parse-then-whitelist path this returned '' twice over.
      const patch = '*** Begin Patch\n*** Update File: /home/x/prisma/schema.prisma\n@@\n model Payment {';
      const { query, miss } = deriveQueryDetailed('apply_patch', patch);
      expect(miss).toBeNull();
      expect(query).toContain('/home/x/prisma/schema.prisma');
    });
    it('derives from view_image path', () => {
      expect(deriveQuery('view_image', { path: '/tmp/shot.png', detail: 'high' })).toBe('/tmp/shot.png');
    });
  });

  describe('omp (lowercase)', () => {
    it('derives from bash command', () => {
      expect(deriveQuery('bash', { command: 'pwd && git status' })).toContain('pwd && git status');
    });
    it("accepts omp's `path` where claude's Read uses `file_path`", () => {
      // Not an assumption: omp's read/edit/write key on `path`. Both spellings
      // are accepted so neither client depends on the other's naming.
      expect(deriveQuery('read', { path: '/a/b.ts' })).toBe('/a/b.ts');
      expect(deriveQuery('read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    });
    it('derives from grep pattern/path/glob', () => {
      expect(deriveQuery('grep', { pattern: 'needle', path: 'src' })).toBe('needle src');
    });

    describe('XD dynamic-device writes (P-014 / D-012)', () => {
      const toolsInvokePath = 'xd://mcp__papercusp_su_tools_invoke';

      it('replays the exact 2026-08-12 00:06:17Z two-call shape without querying on the XD path', () => {
        const calls = [
          {
            tool: 'write',
            toolInput: JSON.stringify({
              path: toolsInvokePath,
              content: '{"args": {}, "name": "coord:inbox"}',
            }),
            toolResponse: '{"owner_id":"su-0e500929"}',
          },
          {
            tool: 'write',
            toolInput: JSON.stringify({
              path: toolsInvokePath,
              content: '{"args": {}, "name": "scheduler:get_next"}',
            }),
            toolResponse: 'Error: invalid_input: harness is required',
          },
        ];

        const detail = deriveBatchQueryDetailed(calls);
        // Both exact inner calls are deliberate no-signal bookkeeping calls.
        // The important regression is that neither generic 35-char path is
        // embedded (twice, joined into D-012's measured 73-char query).
        expect(detail).toEqual({ query: '', unknownTools: [], noSignalTools: ['write'] });
        expect(detail.query).not.toContain('xd://');
        for (const call of calls) {
          expect(deriveQueryDetailed(call.tool, call.toolInput)).toEqual({
            query: '',
            miss: 'no-signal',
          });
        }
      });

      it('derives through the inner tools:invoke vocabulary instead of the dispatcher path', () => {
        const query = deriveQuery('write', {
          path: toolsInvokePath,
          content: JSON.stringify({
            name: 'dev:pg_query',
            args: { sql: 'SELECT count(*) FROM harness_shared.work_items' },
          }),
        });
        expect(query).toBe('SELECT count(*) FROM harness_shared.work_items');
        expect(query).not.toContain('xd://');
        expect(query).not.toContain('tools_invoke');
      });

      it('keeps ordinary file writes unchanged and never admits their body', () => {
        const secret = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI';
        const query = deriveQuery('write', {
          path: '/repo/notes.txt',
          content: secret,
        });
        expect(query).toBe('/repo/notes.txt');
        expect(query).not.toContain(secret);
      });

      it('never treats malformed XD content as raw query text', () => {
        const malformed = '{"name":"dev:pg_query","args":{"sql":"AWS_SECRET_ACCESS_KEY=';
        const detail = deriveQueryDetailed('write', {
          path: toolsInvokePath,
          content: malformed,
        });
        expect(detail).toEqual({ query: '', miss: 'no-signal' });
        expect(detail.query).not.toContain('AWS_SECRET_ACCESS_KEY');
      });

      it("fails closed when the hook's 400-char clamp truncates the outer XD JSON", () => {
        const truncated = JSON.stringify({
          path: toolsInvokePath,
          content: JSON.stringify({
            name: 'dev:pg_query',
            args: { sql: `SELECT '${'secret'.repeat(100)}'` },
          }),
        }).slice(0, 400);
        expect(() => JSON.parse(truncated)).toThrow();
        expect(deriveQueryDetailed('write', truncated)).toEqual({
          query: '',
          miss: 'no-signal',
        });
      });
    });
  });

  describe('a miss says WHICH KIND — the D-005 §3b observability requirement', () => {
    it("classifies an unmapped tool as 'unknown-tool' (drift — actionable)", () => {
      expect(deriveQueryDetailed('SomeFutureTool', { x: 1 }).miss).toBe('unknown-tool');
      expect(deriveQueryDetailed('', {}).miss).toBe('unknown-tool');
    });
    it("classifies a known tool with no signal as 'no-signal' (expected quiet)", () => {
      // `wait` is deliberately in the vocabulary WITH no fields, precisely so it
      // reads as expected quiet rather than as vocabulary drift.
      expect(deriveQueryDetailed('wait', { cell_id: '4' }).miss).toBe('no-signal');
      expect(deriveQueryDetailed('Bash', { command: '' }).miss).toBe('no-signal');
    });
    it('never reports a miss and a query at the same time', () => {
      for (const [tool, input] of [
        ['Bash', { command: 'x' }],
        ['exec_command', { cmd: 'y' }],
        ['wait', {}],
        ['NotATool', {}],
      ] as const) {
        const { query, miss } = deriveQueryDetailed(tool, input);
        expect(Boolean(query)).toBe(miss === null);
      }
    });
    it('an unmapped tool cannot smuggle a raw blob into the embedder', () => {
      // The old parse-failure fallback was whitelisted to claude's four names.
      // The widened one must stay whitelisted to the vocabulary, or any unknown
      // tool's clamped JSON becomes an embedded query.
      expect(deriveQuery('NotATool', 'a raw unparseable blob')).toBe('');
    });
  });

  describe('deliberate omissions are decisions, not gaps', () => {
    it('write_stdin derives nothing — its `chars` is raw typed stdin (credentials)', () => {
      const { query, miss } = deriveQueryDetailed('write_stdin', {
        chars: 'hunter2\n',
        session_id: '26614',
      });
      expect(query).toBe('');
      // Known-but-omitted, NOT unknown: the alarm must not read this as drift.
      expect(miss).toBe('no-signal');
    });

    /**
     * claude's Edit/Write carry the SAME `file_path` signal as the already
     * mapped Read and were simply never added — 957 claude NATIVE calls/day
     * derived nothing (Edit 581, ToolSearch 256, Write 69). WI-37587.
     */
    it('Edit/Write derive their file_path, exactly as Read already does', () => {
      expect(deriveQuery('Edit', { file_path: '/repo/a.ts' })).toBe('/repo/a.ts');
      expect(deriveQuery('Write', { file_path: '/repo/b.ts' })).toBe('/repo/b.ts');
      // Same signal as the tool that was already mapped — that is the point.
      expect(deriveQuery('Read', { file_path: '/repo/a.ts' })).toBe('/repo/a.ts');
    });

    /**
     * CREDENTIAL GUARD. Edit/Write map `file_path` ONLY. The bodies are
     * unbounded and credential-bearing on the same argument that excludes
     * write_stdin's `chars` — and the derived query is EMBEDDED, where
     * detectPossibleSecrets does not protect it. This is the assertion that
     * fails if someone later "completes" the mapping with the body fields.
     */
    it('Edit/Write never leak file BODIES into the embedded query', () => {
      const secret = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI';
      const edit = deriveQuery('Edit', {
        file_path: '/repo/.env',
        old_string: secret,
        new_string: `${secret}rotated`,
      });
      expect(edit).toBe('/repo/.env');
      expect(edit).not.toContain('wJalrXUtnFEMI');

      const write = deriveQuery('Write', { file_path: '/repo/.env', content: secret });
      expect(write).toBe('/repo/.env');
      expect(write).not.toContain('wJalrXUtnFEMI');
    });

    it('ToolSearch/WebSearch/WebFetch derive their query text', () => {
      expect(deriveQuery('ToolSearch', { query: 'select:Read,Edit' })).toBe('select:Read,Edit');
      expect(deriveQuery('WebSearch', { query: 'vitest 4 config' })).toBe('vitest 4 config');
      expect(deriveQuery('WebFetch', { url: 'https://x.dev/a', prompt: 'what is the API' })).toBe(
        'https://x.dev/a — what is the API',
      );
    });

    it('claude bookkeeping tools read as expected quiet, not as drift', () => {
      for (const tool of ['AskUserQuestion', 'Artifact', 'Skill', 'Monitor', 'TaskCreate', 'TaskUpdate', 'TaskStop']) {
        expect(deriveQueryDetailed(tool, { anything: 'x' }).miss, `${tool}`).toBe('no-signal');
      }
    });

    /**
     * codex's goal extension (0.146.0) postdates the rollout census in the
     * vocabulary's provenance block, so these three were REAL drift — and
     * `get_goal` is the one the drift alarm actually caught in production:
     * two live rows in context_injection_coverage on 2026-08-09,
     * client=codex port=mid-turn outcome='unknown-tool' tool='get_goal'.
     */
    it('get_goal reads as expected quiet, not drift — it takes NO arguments', () => {
      const { query, miss } = deriveQueryDetailed('get_goal', {});
      expect(query).toBe('');
      // The measured production symptom was 'unknown-tool'. This is the fix.
      expect(miss).toBe('no-signal');
    });

    it('update_goal derives nothing — its only argument is a status enum', () => {
      // Measured from the codex binary: `struct UpdateGoalArgs with 1 element`,
      // admissible values "complete" / "blocked". Embedding "complete" as a
      // recall query matches on a token carrying no topic.
      for (const status of ['complete', 'blocked']) {
        const { query, miss } = deriveQueryDetailed('update_goal', { status });
        expect(query).toBe('');
        expect(miss).toBe('no-signal');
      }
    });

    it('create_goal DOES derive — `objective` is the agent stating its own aim', () => {
      const { query, miss } = deriveQueryDetailed('create_goal', {
        objective: 'make codex mid-turn injection emit a recall row',
        token_budget: 50_000,
      });
      expect(query).toBe('make codex mid-turn injection emit a recall row');
      expect(miss).toBeNull();
      // token_budget is a number and must never reach the embedder.
      expect(query).not.toContain('50000');
    });

    /**
     * CONTROL for the omission asymmetry documented on the vocabulary. A tool
     * mapped to a field it does NOT have derives '' and classifies
     * 'no-signal' — indistinguishable from a deliberate omission — so a
     * guessed mapping silently converts a working drift alarm into permanent
     * quiet. This asserts we did not do that to update_goal: it must stay
     * empty-by-decision rather than pick up a plausible-looking text field.
     */
    it('update_goal is empty BY DECISION, not by a wrong field name', () => {
      expect(TOOL_QUERY_VOCABULARY.update_goal?.fields).toEqual([]);
      // Had we mapped it to a guessed free-text field, these would derive.
      for (const guessed of ['goal', 'description', 'objective', 'plan']) {
        expect(deriveQuery('update_goal', { [guessed]: 'some text' })).toBe('');
      }
    });
  });

  describe('batch derive reports both miss kinds', () => {
    it('separates unknown tools from known-but-quiet ones', () => {
      const { query, unknownTools, noSignalTools } = deriveBatchQueryDetailed([
        { tool: 'exec_command', toolInput: { cmd: 'ls' }, toolResponse: 'a.ts' },
        { tool: 'wait', toolInput: { cell_id: '1' }, toolResponse: '' },
        { tool: 'MysteryTool', toolInput: {}, toolResponse: '' },
      ]);
      expect(query).toContain('ls');
      expect(unknownTools).toEqual(['MysteryTool']);
      expect(noSignalTools).toEqual(['wait']);
    });
    it('deriveBatchQuery stays a pure string view of the detailed form', () => {
      const calls = [{ tool: 'bash', toolInput: { command: 'echo hi' }, toolResponse: 'hi' }];
      expect(deriveBatchQuery(calls)).toBe(deriveBatchQueryDetailed(calls).query);
    });
  });

  /**
   * CONTROLS. These fail if the widening is reverted to the claude-only switch —
   * without them the suite above could pass against an implementation that had
   * quietly lost every non-claude client, which is exactly the failure that went
   * unnoticed for the life of this endpoint.
   */
  describe('controls — these fail if the vocabulary narrows back to claude', () => {
    it('carries entries for all THREE clients, not just claude', () => {
      expect(TOOL_QUERY_VOCABULARY.Bash).toBeDefined(); // claude
      expect(TOOL_QUERY_VOCABULARY.exec_command).toBeDefined(); // codex
      expect(TOOL_QUERY_VOCABULARY.bash).toBeDefined(); // omp
    });
    it('every codex/omp signal tool actually derives a non-empty query', () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['exec_command', { cmd: 'ls -la' }],
        ['view_image', { path: '/tmp/a.png' }],
        ['update_plan', { plan: 'step one' }],
        ['create_goal', { objective: 'ship the thing' }],
        ['bash', { command: 'ls' }],
        ['read', { path: '/a.ts' }],
        ['grep', { pattern: 'x' }],
        ['glob', { pattern: '*.ts' }],
        ['find', { pattern: 'x' }],
        ['edit', { path: '/a.ts' }],
        ['write', { path: '/a.ts' }],
      ];
      for (const [tool, input] of cases) {
        expect(deriveQuery(tool, input), `${tool} must derive a query`).not.toBe('');
      }
    });
    it('a claude-only vocabulary would fail this suite', () => {
      // The explicit inverse of the pre-D-005 behaviour: each of these returned
      // '' before the widening.
      const preD005 = ['Bash', 'Grep', 'Glob', 'Read'];
      for (const tool of ['exec_command', 'apply_patch', 'bash', 'read']) {
        expect(preD005).not.toContain(tool);
        expect(TOOL_QUERY_VOCABULARY[tool]).toBeDefined();
      }
    });
  });
});

/**
 * THE DERIVE-MISS TRACE (D-005 §3b — the durable half of P-005).
 *
 * Widening the vocabulary fixes today's clients. It does NOT fix the thing that
 * let the gap hide: the handler dropped an empty derive BEFORE the stats write,
 * so "the hook fired and the server derived nothing" wrote no row and was
 * indistinguishable from "the hook never fired". The next vocabulary drift
 * would have recreated the same blind spot.
 *
 * These assert the four outcomes stay DISTINGUISHABLE from the outside, which
 * is what lets the alarm name a cause instead of guessing one.
 */
describe('derive-miss leaves a trace (D-005 §3b)', () => {
  it('records unknown-tool for an unmapped tool — the previously SILENT path', () => {
    // Before this, the handler returned here having written nothing at all.
    return post({ owner: owner(), client: 'codex', tool: 'MysteryTool', toolInput: {} }).then((res) => {
      expect(res.text).toBe('');
      expect(coverageEvents()).toContainEqual(
        expect.objectContaining({
          port: 'mid-turn',
          client: 'codex',
          outcome: 'unknown-tool',
          tool: 'MysteryTool',
        }),
      );
    });
  });

  it('records no-signal for a KNOWN tool that carried nothing', async () => {
    await post({ owner: owner(), client: 'codex', tool: 'wait', toolInput: { cell_id: '4' } });
    expect(coverageEvents()).toContainEqual(expect.objectContaining({ outcome: 'no-signal', tool: 'wait' }));
  });

  it('records drift even when OTHER calls in the batch DID carry signal', async () => {
    // The dangerous case: the batch succeeds, so nothing looks wrong, while a
    // tool we cannot read goes unnoticed.
    const res = await post({
      owner: owner(),
      client: 'codex',
      toolCalls: [
        { tool: 'exec_command', toolInput: { cmd: 'rg foo' }, toolResponse: 'hit' },
        { tool: 'BrandNewTool', toolInput: {}, toolResponse: '' },
      ],
    });
    expect(res.text).toContain('MEM'); // the batch DID produce a recall
    expect(coverageEvents()).toContainEqual(expect.objectContaining({ outcome: 'unknown-tool', tool: 'BrandNewTool' }));
  });

  it("records 'recalled' when the recall returned context", async () => {
    await post({ owner: owner(), client: 'claude', tool: 'Bash', toolInput: { command: 'rg x' } });
    expect(coverageEvents()).toContainEqual(expect.objectContaining({ outcome: 'recalled' }));
  });

  it("records 'no-recall' — healthy quiet — when it ran and found nothing", async () => {
    // The state an alarm must NOT fire on, and cannot see without this.
    buildMemoryContextBlockMock.mockResolvedValue('');
    await post({ owner: owner(), client: 'omp', tool: 'bash', toolInput: { command: 'ls' } });
    expect(coverageEvents()).toContainEqual(expect.objectContaining({ outcome: 'no-recall' }));
    expect(coverageEvents()).not.toContainEqual(expect.objectContaining({ outcome: 'recalled' }));
  });

  it('threads client and workspace so coverage is per-(client, port)', async () => {
    await post({ owner: owner(), client: 'omp', tool: 'read', toolInput: { path: '/a.ts' } });
    expect(coverageEvents()[0]).toMatchObject({
      client: 'omp',
      port: 'mid-turn',
      workspaceId: 'ws-test',
    });
  });

  it("uses '' — not a guessed client — when the caller sent none", async () => {
    // A host without the P-005 threading is a REAL and distinct reading; a
    // defaulted client name would silently attribute rows to the wrong TUI.
    await post({ owner: owner(), tool: 'Bash', toolInput: { command: 'rg x' } });
    expect(coverageEvents()[0]).toMatchObject({ client: '' });
  });

  /** CONTROL — fails if the trace is removed and the early return goes silent again. */
  it('CONTROL: a miss-only call records at least one event', async () => {
    await post({ owner: owner(), client: 'codex', tool: 'NoSuchTool', toolInput: {} });
    expect(
      coverageEvents().length,
      'a derive-miss that records nothing is the exact D-005 §3b regression',
    ).toBeGreaterThan(0);
  });
});

describe('papercusp MCP vocabulary — the 97% of drift-alarm noise (WI-37589)', () => {
  // Measured 2026-08-09 from context_injection_coverage: 79 distinct
  // mcp__papercusp-su__* tools, 2,424 calls/day deriving nothing. After
  // WI-37587 fixed claude's NATIVE tools this WAS the remaining noise floor,
  // and an alarm that is ~100% noise cannot show a real drift event.
  describe('every client spelling resolves to one entry', () => {
    it('resolves the CLIENT-MANGLED name a hook actually sends', () => {
      expect(deriveQuery('mcp__papercusp-su__dev_pg_query', { sql: 'SELECT 1 FROM plans' })).toBe(
        'SELECT 1 FROM plans',
      );
    });
    it('resolves the COLON name, which is what tools:invoke carries', () => {
      expect(deriveQuery('dev:pg_query', { sql: 'SELECT 1 FROM plans' })).toBe('SELECT 1 FROM plans');
    });
    it('capability:bash mirrors claude Bash exactly — same fields, same em-dash', () => {
      const args = { command: 'rg foo', description: 'find foo' };
      expect(deriveQuery('mcp__papercusp-su__capability_bash', args)).toBe(deriveQuery('Bash', args));
    });

    /**
     * EI-21905492455933253 — THE CLIENTS DO NOT MANGLE ALIKE. claude/omp replace
     * ':' only, so hyphens survive; codex replaces '-' as well. Registering only
     * the first spelling made every DECLARED tool whose colon name contains a
     * hyphen resolve as `unknown-tool` from codex — the drift alarm firing on
     * tools sitting in the vocabulary itself.
     *
     * The strings below are the EXACT ones observed in
     * context_injection_coverage (port='mid-turn', outcome='unknown-tool'), not
     * constructed for the test: session_request_compaction at 4,760 calls / 3
     * days and fleet_leader_brief at 170.
     *
     * This regresses INVISIBLY without a guard — the symptom is a telemetry row
     * nobody reads, never a failing turn — which is the whole reason it is here.
     */
    it("resolves codex's spelling, which mangles '-' to '_' as well as ':'", () => {
      expect(deriveQueryDetailed('mcp__papercusp_su__session_request_compaction', { focus: 'x' })).toEqual({
        query: '',
        miss: 'no-signal',
      });
      expect(deriveQueryDetailed('mcp__papercusp_su__fleet_leader_brief', {}).miss).toBe('no-signal');
    });

    it("does not regress claude's spelling of the same declared tools", () => {
      expect(deriveQueryDetailed('mcp__papercusp-su__session_request-compaction', {}).miss).toBe('no-signal');
      expect(deriveQueryDetailed('mcp__papercusp-su__fleet_leader-brief', {}).miss).toBe('no-signal');
    });

    it('resolves a SIGNAL-bearing tool under the codex spelling too', () => {
      // codex is ~77% of mid-turn traffic, so this is the path that matters most.
      expect(deriveQuery('mcp__papercusp_su__dev_pg_query', { sql: 'SELECT 1 FROM plans' })).toBe(
        'SELECT 1 FROM plans',
      );
    });

    /**
     * NEGATIVE CONTROLS. Widening resolution must cover DECLARED tools only — if
     * it also started resolving unmapped ones the alarm would go quiet, which is
     * strictly worse than the noise it was fixing.
     */
    it('leaves a genuinely UNMAPPED tool loud in both spellings', () => {
      // coord:declare-intent is the single largest unknown-tool row (9,004 codex
      // calls / 3 days) and is deliberately NOT in the vocabulary. It must stay
      // reported as drift rather than be swallowed by the widening.
      expect(deriveQueryDetailed('mcp__papercusp_su__coord_declare_intent', { intent: 'x' }).miss).toBe(
        'unknown-tool',
      );
      expect(deriveQueryDetailed('mcp__papercusp-su__coord_declare-intent', { intent: 'x' }).miss).toBe(
        'unknown-tool',
      );
      expect(deriveQueryDetailed('mcp__papercusp_su__brand_new_verb', { q: 'x' }).miss).toBe('unknown-tool');
    });
  });

  describe('tools:invoke recurses — its own args are the WRONG reading', () => {
    // The single biggest miss in the vocabulary (423 calls/day, 17% of the MCP
    // namespace). Its args are { name, args }: reading THOSE embeds the literal
    // string "dev:pg_query" plus a JSON blob, so the only correct reading is
    // the inner tool's own entry.
    it('derives from the INNER tool, not from name/args', () => {
      const q = deriveQuery('mcp__papercusp-su__tools_invoke', {
        name: 'dev:pg_query',
        args: { sql: 'SELECT count(*) FROM harness_shared.work_items' },
      });
      expect(q).toBe('SELECT count(*) FROM harness_shared.work_items');
      // The dispatcher's own field values must not leak into the query.
      expect(q).not.toContain('dev:pg_query');
    });
    it('an inner tool that carries no signal is no-signal, NOT unknown-tool', () => {
      expect(deriveQueryDetailed('tools:invoke', { name: 'work_items:get', args: { id: 'WI-1' } })).toEqual({
        query: '',
        miss: 'no-signal',
      });
    });
    it('an UNMAPPED inner tool is reported under the INNER name, not the dispatcher', () => {
      // Reporting "tools:invoke is unmapped" would put a perfectly mapped tool
      // in the drift list and point nobody at the real gap.
      const d = deriveQueryDetailed('mcp__papercusp-su__tools_invoke', {
        name: 'brand:new_verb',
        args: { query: 'x' },
      });
      expect(d.miss).toBe('unknown-tool');
      expect(d.missTool).toBe('brand:new_verb');
    });
    it('surfaces that inner name in unknownTools, which is what the alarm reads', () => {
      const { unknownTools } = deriveBatchQueryDetailed([
        {
          tool: 'mcp__papercusp-su__tools_invoke',
          toolInput: JSON.stringify({ name: 'brand:new_verb', args: {} }),
        },
      ]);
      expect(unknownTools).toEqual(['brand:new_verb']);
      expect(unknownTools).not.toContain('mcp__papercusp-su__tools_invoke');
    });
    it('a dispatch through a dispatch terminates instead of recursing', () => {
      expect(
        deriveQueryDetailed('tools:invoke', {
          name: 'tools:invoke',
          args: { name: 'tools:invoke', args: {} },
        }),
      ).toEqual({ query: '', miss: 'no-signal' });
    });
  });

  describe('NEGATIVE CONTROLS — the ways a wrong mapping would be worse than none', () => {
    // A wrong field name derives '' and classifies 'no-signal', which is
    // INDISTINGUISHABLE from a deliberate omission — so it silently converts a
    // working alarm into permanent quiet. These are the shapes that would do it.
    it('a THIRD-PARTY mcp tool does not borrow an omp entry with the same suffix', () => {
      // `mcp__some-server__read` must NOT resolve to omp's `read` spec. If the
      // prefix guard is dropped this returns '' (from omp's path/file_path,
      // which this payload lacks) and reads as a deliberate omission.
      const d = deriveQueryDetailed('mcp__some-server__read', { path: '/x/y.ts' });
      expect(d.miss).toBe('unknown-tool');
    });
    it('the bare omp `read` still works — the control for the control', () => {
      // Without this, the assertion above would also pass if `read` had simply
      // been deleted from the vocabulary.
      expect(deriveQuery('read', { path: '/x/y.ts' })).toBe('/x/y.ts');
    });
    it('an unmapped papercusp tool stays LOUD rather than being blanket-silenced', () => {
      // The ~60 calls/day tail is deliberately still 'unknown-tool': that floor
      // is what makes a genuinely new tool arriving at 100+/day visible.
      expect(deriveQueryDetailed('mcp__papercusp-su__brand_new_verb', { query: 'x' })).toEqual({
        query: '',
        miss: 'unknown-tool',
      });
    });
    it('bookkeeping tools are no-signal, so the alarm cannot read them as drift', () => {
      for (const tool of [
        'mcp__papercusp-su__loop_checkpoint',
        'mcp__papercusp-su__work_items_complete',
        'mcp__papercusp-su__coord_send',
        'mcp__papercusp-su__plans_get',
      ]) {
        expect(deriveQueryDetailed(tool, { id: 'WI-1', body: 'done' }).miss).toBe('no-signal');
      }
    });
    it('never embeds an opaque identifier as a recall query', () => {
      // The concrete refutation of deriving this vocabulary from the defineTool
      // registry: the schema would happily map work_items:get -> id and
      // plans:get -> slug, and an id retrieves on token overlap with unrelated
      // records. An ANTI-signal is worse than no signal.
      expect(deriveQuery('mcp__papercusp-su__work_items_get', { id: 'WI-37589' })).toBe('');
      expect(deriveQuery('mcp__papercusp-su__plans_get', { slug: 'some-plan-2026' })).toBe('');
    });
    it('coord:orient drops `intent` on purpose — orient already recalls on it', () => {
      // Mapping it would re-embed the same string and inject the same records
      // twice in one turn. Strong signal, deliberately not taken HERE.
      expect(deriveQuery('mcp__papercusp-su__coord_orient', { intent: 'fix the gate' })).toBe('');
    });
    it('does not embed unbounded bodies — code:run takes title/description, not script', () => {
      const q = deriveQuery('mcp__papercusp-su__code_run', {
        title: 'count claimable',
        description: 'burn-down probe',
        script: 'const secret = "sk-do-not-embed-me";',
      });
      expect(q).toBe('count claimable burn-down probe');
      expect(q).not.toContain('sk-do-not-embed-me');
    });
  });
});

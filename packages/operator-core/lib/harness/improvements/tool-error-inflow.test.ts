/**
 * tool-error-inflow.test.ts — bug-inflow-one-problem-one-row-2026-10-18 R-1..R-3
 * end to end over the pure seams: raw failure messages → structural key parts →
 * classified rows → watchdog signals → the per-tool daily mint cap, plus one
 * hermetic tick proving the cap is applied where rows are minted.
 *
 *   R-1  transient failures are COUNTED, not filed, unless sustained; one row per tool.
 *   R-2  caller failures key by tool + field (+ code), whatever the value/ids.
 *   R-3  structural failures key without a message fingerprint; a tool mints at
 *        most N new rows a day (capped signals are deferred, never dropped).
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateToolErrorRowsByKey,
  capToolErrorMintsPerTool,
  runWatchdogTick,
  toolErrorSignalsFromRows,
  type ClassifiedToolErrorRow,
  type WatchdogKeyDup,
  type WatchdogSignal,
} from './watchdog';
import { classifyToolError, toolErrorKeyParts } from './tool-error-classifier';

/** One classified row per raw failure, keyed the way the SQL collector keys them. */
function rowsFrom(
  tool: string,
  failures: Array<{ code: string | null; message: string; at?: string }>,
  total: number,
  activeHours = 6,
): ClassifiedToolErrorRow[] {
  return failures.map((f) => {
    const klass = classifyToolError(f.code, 'error', f.message);
    const parts = toolErrorKeyParts(f.code, f.message);
    const toolKeyed = klass === 'transient' || klass === 'rate-limit';
    return {
      tool_name: tool,
      class: klass,
      code_key: toolKeyed ? null : parts.errorCode,
      field_key: toolKeyed ? null : parts.fieldPath,
      n: 1,
      total,
      active_hours: activeHours / failures.length,
      sample: f.message,
      latest_at: f.at ?? null,
    };
  });
}

function sig(tool: string, key: string, severity: WatchdogSignal['severity'] = 'major'): WatchdogSignal {
  return {
    source: 'repeated-tool-error',
    key,
    title: `Tool ${tool} ${key}`,
    body: 'detail',
    severity,
  };
}

describe('R-3: structural failures that differ only in ids/paths are ONE row', () => {
  const failures = Array.from({ length: 6 }, (_, i) => ({
    code: 'handler_error',
    message: `handler_error: claim_conflict: WI-${1000 + i} is held by su-${i}abc until 1${i}:00 (lock ${i}f${i})`,
  }));

  it('folds onto one structural key with no message digest, counting every occurrence', () => {
    const keyed = aggregateToolErrorRowsByKey(rowsFrom('work_items:claim', failures, 40));
    expect(keyed).toHaveLength(1);
    expect(keyed[0].key).toBe('work_items:claim:structural:claim_conflict:field-unknown');
    expect(keyed[0].key).not.toMatch(/md5-/);
    expect(keyed[0].n).toBe(6);

    const signals = toolErrorSignalsFromRows(rowsFrom('work_items:claim', failures, 40));
    expect(signals).toHaveLength(1);
    expect(signals[0].body).toMatch(/6×/);
  });
});

describe('R-2: caller failures key by tool + field', () => {
  it('different values / indices under the same field share one usability item', () => {
    const failures = [
      ...Array.from({ length: 6 }, (_, i) => ({ code: 'invalid_input', message: `invalid_input: invalid_args: items.${i}.status: Invalid option: expected one of "todo"|"done", received "x${i}"` })),
      ...Array.from({ length: 6 }, (_, i) => ({ code: 'invalid_input', message: `invalid_args: items.${i + 10}.status: Required (call ${i})` })),
    ];
    const signals = toolErrorSignalsFromRows(rowsFrom('plans:set-status', failures, 30));
    expect(signals.map((s) => s.key)).toEqual(['plans:set-status:caller:invalid_args:items.n.status']);
    expect(signals[0].kind).toBe('change');
  });

  it('a different field is a different usability item', () => {
    const failures = [
      ...Array.from({ length: 10 }, () => ({ code: 'invalid_input', message: 'invalid_input: invalid_args: Unrecognized key: "request_key"' })),
      ...Array.from({ length: 10 }, () => ({ code: 'invalid_input', message: 'invalid_input: invalid_args: Unrecognized key: "summary"' })),
    ];
    const keys = toolErrorSignalsFromRows(rowsFrom('coord:send', failures, 50)).map((s) => s.key).sort();
    expect(keys).toEqual([
      'coord:send:caller:invalid_args:request_key',
      'coord:send:caller:invalid_args:summary',
    ]);
  });
});

describe('R-1: transient failures are counted, not filed, unless sustained', () => {
  const timeouts = (n: number) => Array.from({ length: n }, (_, i) => ({
    code: 'timeout',
    message: `tool "sessions:search" exceeded timeout of ${30 + i}s (request ${i})`,
  }));

  it('below the sustained-rate bar: zero signals, however many wordings', () => {
    // Enough volume and a high rate, but compressed into one hour — a load burst.
    expect(toolErrorSignalsFromRows(rowsFrom('sessions:search', timeouts(40), 50, 1))).toEqual([]);
    // Enough volume and spread out, but a small share of the tool's calls.
    expect(toolErrorSignalsFromRows(rowsFrom('sessions:search', timeouts(40), 2000, 8))).toEqual([]);
  });

  it('above the bar: exactly ONE signal keyed by the tool, from many distinct wordings', () => {
    const signals = toolErrorSignalsFromRows(rowsFrom('sessions:search', timeouts(40), 100, 8));
    expect(signals.map((s) => s.key)).toEqual(['sessions:search:transient']);
    expect(signals[0].body).toMatch(/40×/);
  });
});

describe('capToolErrorMintsPerTool (R-3 daily cap)', () => {
  it('admits at most `cap` new rows per tool, highest severity first, and defers the rest', () => {
    const a1 = sig('a:tool', 'a:tool:structural:x_code:field-unknown', 'minor');
    const a2 = sig('a:tool', 'a:tool:structural:y_code:field-unknown', 'critical');
    const b1 = sig('b:tool', 'b:tool:caller:invalid_args:slug', 'minor');
    const other: WatchdogSignal = { ...sig('x', 'red.test.ts'), source: 'red-test' };
    const r = capToolErrorMintsPerTool([a1, a2, b1, other], new Map(), 1);
    expect(r.admitted).toEqual([a2, b1, other]); // input order kept for the admitted set
    expect(r.capped).toEqual([a1]);
  });

  it('counts rows the tool already minted today against its budget', () => {
    const b1 = sig('b:tool', 'b:tool:caller:invalid_args:slug');
    const c1 = sig('c:tool', 'c:tool:transient');
    const r = capToolErrorMintsPerTool([b1, c1], new Map([['b:tool', 1]]), 1);
    expect(r.admitted).toEqual([c1]);
    expect(r.capped).toEqual([b1]);
  });

  it('a raised cap admits more; a zero cap admits no tool-error mints at all', () => {
    const s = [sig('a:tool', 'a:tool:structural:x:f'), sig('a:tool', 'a:tool:structural:y:f')];
    expect(capToolErrorMintsPerTool(s, new Map(), 2).capped).toEqual([]);
    expect(capToolErrorMintsPerTool(s, new Map(), 0).admitted).toEqual([]);
  });
});

describe('the daily cap is applied in the tick, where rows are minted', () => {
  const noKeyDups = async (): Promise<WatchdogKeyDup[]> => [];

  function captureRec() {
    const captured: string[] = [];
    const capture = (async (input: { title: string }) => {
      captured.push(input.title);
      return { ok: true, created: true, issue: { id: `iss-${captured.length}` } as never, possibleDuplicates: [] };
    }) as unknown as typeof import('./capture-core').captureImprovement;
    return { captured, capture };
  }

  it('mints one row for a tool that has budget, defers its second, and none for a tool already at cap', async () => {
    const { captured, capture } = captureRec();
    const aMajor = sig('a:tool', 'a:tool:structural:x_code:field-unknown', 'major');
    const aMinor = sig('a:tool', 'a:tool:structural:y_code:field-unknown', 'minor');
    const bSig = sig('b:tool', 'b:tool:caller:invalid_args:slug', 'major');
    const res = await runWatchdogTick('ws', { maxPerTick: 10 }, {
      withTickLock: async (_ws, fn) => ({ ran: true, value: await fn() }),
      readKeyDups: noKeyDups,
      pruneTicks: async () => {},
      collect: async () => [aMajor, aMinor, bSig],
      capture,
      recordTick: async () => {},
      readRecentTicks: async () => [],
      readToolErrorMintsByTool: async () => new Map([['b:tool', 1]]),
    });
    expect(captured).toEqual([aMajor.title]);
    expect((res as { deferredKeys?: string[] }).deferredKeys ?? []).toEqual(expect.arrayContaining([
      `repeated-tool-error:${aMinor.key}`,
      `repeated-tool-error:${bSig.key}`,
    ]));
  });

  it('fails OPEN when the mint count is unreadable', async () => {
    const { captured, capture } = captureRec();
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await runWatchdogTick('ws', { maxPerTick: 10 }, {
        withTickLock: async (_ws, fn) => ({ ran: true, value: await fn() }),
        readKeyDups: noKeyDups,
        pruneTicks: async () => {},
        collect: async () => [sig('a:tool', 'a:tool:structural:x_code:field-unknown')],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
        readToolErrorMintsByTool: async () => { throw new Error('pg down'); },
      });
    } finally {
      console.warn = warn;
    }
    expect(captured).toHaveLength(1);
    expect(String(warnings[0])).toMatch(/daily cap unavailable/);
  });
});

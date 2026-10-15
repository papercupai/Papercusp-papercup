/**
 * apply.ts — the fail-OPEN half.
 *
 * Two things are asserted harder than the rest, because they are what makes the
 * stage safe to auto-substitute into (P-021/P-022):
 *   1. operator semantics MATCH the coreutils they stand in for (adjacent-only
 *      uniq, cut's non-delimited passthrough, grep's `--` group separator);
 *   2. a projection that does not fit is LOUD — the reason reaches the in-band
 *      footer, not just _meta, because the footer is what the agent reads.
 */

import { describe, expect, it } from 'vitest';
import {
  applyPick,
  applyResultProjection,
  PICK_MISS_FAIL_OPEN_MAX_CHARS,
  parsePickPath,
  pickPathTail,
  pickRepairCandidates,
  projectionMaterializationFormat,
  proposePickRepairs,
  renderJsonForLineOps,
} from './apply';
import { parseProjection } from './parse';
import { nestedProjectionContext } from './nested-dispatch';
import type { UnifiedToolContext } from '@papercusp/tooldef';
import { senderBodyDeliveryDiagnostics } from '../agent-tools/coordination/tools/inbox-content-bounds';

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/** Parse through the real validator so a test can never assert on a spec the parser would reject. */
function spec(raw: unknown) {
  const r = parseProjection(raw);
  if (!r.ok) throw new Error(`fixture spec rejected by parser: ${r.error}`);
  return r.spec;
}

/**
 * The verdict block (stats + notes) is identified by its `[projection:` stats
 * marker, NOT by position: a DEGRADED verdict renders as a HEADER (first item,
 * so head-keeping truncation downstream cannot silence it) while a clean one
 * stays a tail footer — EI-20720054720826414. Position-blind helpers are what
 * let these tests assert content without hard-coding either placement; the
 * placement itself is asserted explicitly in its own describe block below.
 */
const textsOf = (r: { content: ReadonlyArray<{ type?: string; text?: string }> }) =>
  r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
const isVerdictText = (t: string) => t.includes('[projection:');
const bodyText = (r: { content: ReadonlyArray<{ type?: string; text?: string }> }) =>
  textsOf(r).find((t) => !isVerdictText(t)) ?? '';
const footerOf = (r: { content: ReadonlyArray<{ type?: string; text?: string }> }) =>
  textsOf(r).find(isVerdictText) ?? '';
const reportOf = (r: { content?: unknown; _meta?: Record<string, unknown> }) =>
  r._meta?.resultProjection as {
    applied: boolean;
    notes: string[];
    linesIn: number;
    linesOut: number;
    regexFlavor?: string;
  };

describe('EI-25185987580518406 coordination send receipts', () => {
  it.each([421, 700])('does not label a complete %i-character delivery receipt as omitted output', (chars) => {
    const receipt = { results: [{ msg_id: 'already-persisted', ...senderBodyDeliveryDiagnostics('x'.repeat(chars)) }] };
    const out = applyResultProjection(textResult(JSON.stringify(receipt)), spec({ pick: ['results[].msg_id'] }), { toolName: 'coord:send' });
    expect(JSON.parse(bodyText(out))).toEqual({ results: [{ msg_id: 'already-persisted' }] });
    expect(reportOf(out).notes.join('\n')).not.toContain('partial-result metadata');
  });

  it('keeps genuine partial receipt recovery read-only', () => {
    const receipt = { results: [{ msg_id: 'already-persisted', _partial: true }] };
    const out = applyResultProjection(textResult(JSON.stringify(receipt)), spec({ pick: ['results[].msg_id'] }), { toolName: 'coord:send' });
    expect(reportOf(out).notes.join('\n')).toContain('coord:read');
    expect(reportOf(out).notes.join('\n')).toContain('Do not repeat coord:send');
    expect(reportOf(out).notes.join('\n')).not.toMatch(/re-call coord:send/i);
  });
});

describe('projection materialization format', () => {
  it('keeps implicit TOON for line projections but uses JSON for structured picks', () => {
    const context = { requestedFormat: undefined } as UnifiedToolContext;
    const lines = nestedProjectionContext(context, {}, spec({ pipe: [{ op: 'grep', pattern: 'ERROR' }] }));
    const fields = nestedProjectionContext(context, {}, spec({ pick: ['entries[].id'] }));
    expect(lines.requestedFormat).toBeUndefined();
    expect(fields.requestedFormat).toBe('json');
  });

  it('forces JSON for the implicit MCP compact source', () => {
    expect(projectionMaterializationFormat(undefined, true)).toBe('json');
    expect(projectionMaterializationFormat('compact', true)).toBe('json');
    expect(projectionMaterializationFormat(' COMPACT ', true)).toBe('json');
  });

  it('preserves explicit formats and non-materialized contexts', () => {
    expect(projectionMaterializationFormat('json', true)).toBe('json');
    expect(projectionMaterializationFormat('toon', true)).toBe('toon');
    expect(projectionMaterializationFormat('text/csv', true)).toBe('text/csv');
    expect(projectionMaterializationFormat('toon', false)).toBe('toon');
    expect(projectionMaterializationFormat(undefined, false)).toBeUndefined();
  });

  it('normalizes an unsupported request to JSON instead of inheriting compact', () => {
    expect(projectionMaterializationFormat('yaml', true)).toBe('json');
  });
});

describe('applyResultProjection — line operators', () => {
  const LINES = ['alpha 3', 'beta 1', 'ERROR here', 'gamma 2', 'error again', 'delta 10'].join('\n');

  it('no spec returns the very same object (identity, not a copy)', () => {
    const r = textResult('x');
    expect(applyResultProjection(r, null)).toBe(r);
  });

  it('grep filters, and -i is honored', () => {
    const out = applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'grep', pattern: 'error', ignoreCase: true }] }));
    expect(bodyText(out)).toBe('ERROR here\nerror again');
  });

  it('grep -v inverts', () => {
    // 'alpha 3' and 'gamma 2' are the two lines with no 'e' in them.
    const out = applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'grep', pattern: 'e', invert: true }] }));
    expect(bodyText(out)).toBe('alpha 3\ngamma 2');
  });

  it('grep -F matches a literal that would otherwise be a regex', () => {
    const out = applyResultProjection(
      textResult(['a.c', 'abc'].join('\n')),
      spec({ pipe: [{ op: 'grep', pattern: 'a.c', fixed: true }] }),
    );
    expect(bodyText(out)).toBe('a.c');
  });

  it('grep context emits GNU’s `--` between NON-contiguous groups only', () => {
    const lines = ['1', 'HIT', '3', '4', '5', '6', 'HIT', '8'].join('\n');
    const out = applyResultProjection(textResult(lines), spec({ pipe: [{ op: 'grep', pattern: 'HIT', context: 1 }] }));
    expect(bodyText(out)).toBe(['1', 'HIT', '3', '--', '6', 'HIT', '8'].join('\n'));
  });

  it('grep context does NOT separate groups whose windows touch', () => {
    const lines = ['1', 'HIT', '3', 'HIT', '5'].join('\n');
    const out = applyResultProjection(textResult(lines), spec({ pipe: [{ op: 'grep', pattern: 'HIT', context: 1 }] }));
    expect(bodyText(out)).not.toContain('--');
  });

  it('head/tail slice, and tail 0 is empty (not "the whole thing")', () => {
    expect(bodyText(applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'head', n: 2 }] })))).toBe(
      'alpha 3\nbeta 1',
    );
    expect(bodyText(applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'tail', n: 2 }] })))).toBe(
      'error again\ndelta 10',
    );
    // `slice(-0)` is `slice(0)` — the whole array. The guard against that is the
    // difference between "no lines" and "every line".
    expect(bodyText(applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'tail', n: 0 }] })))).toBe('');
  });

  it('sort -n orders numerically, not lexically', () => {
    const nums = ['10', '9', '100'].join('\n');
    expect(bodyText(applyResultProjection(textResult(nums), spec({ pipe: [{ op: 'sort' }] })))).toBe('10\n100\n9');
    expect(bodyText(applyResultProjection(textResult(nums), spec({ pipe: [{ op: 'sort', numeric: true }] })))).toBe(
      '9\n10\n100',
    );
  });

  it('uniq collapses ADJACENT runs only — exactly like the binary', () => {
    const dup = ['a', 'a', 'b', 'a'].join('\n');
    expect(bodyText(applyResultProjection(textResult(dup), spec({ pipe: [{ op: 'uniq' }] })))).toBe('a\nb\na');
    // sort -u is the one that dedupes globally; conflating them silently drops rows.
    expect(bodyText(applyResultProjection(textResult(dup), spec({ pipe: [{ op: 'sort', unique: true }] })))).toBe('a\nb');
  });

  it('uniq -c uses the %7d column format', () => {
    const out = applyResultProjection(textResult(['a', 'a', 'b'].join('\n')), spec({ pipe: [{ op: 'uniq', count: true }] }));
    expect(bodyText(out)).toBe('      2 a\n      1 b');
  });

  it('cut passes NON-delimited lines through whole, unless -s', () => {
    const rows = ['a\tb\tc', 'nodelim', 'x\ty\tz'].join('\n');
    expect(bodyText(applyResultProjection(textResult(rows), spec({ pipe: [{ op: 'cut', fields: [1, 3] }] })))).toBe(
      'a\tc\nnodelim\nx\tz',
    );
    expect(
      bodyText(applyResultProjection(textResult(rows), spec({ pipe: [{ op: 'cut', fields: [1], onlyDelimited: true }] }))),
    ).toBe('a\nx');
  });

  it('count replaces the body with the line count (wc -l)', () => {
    expect(bodyText(applyResultProjection(textResult(LINES), spec({ pipe: [{ op: 'count' }] })))).toBe('6');
  });

  it('stages compose in order — the corpus shape grep | sort | uniq -c | head', () => {
    const log = ['e b', 'e a', 'x', 'e b', 'e a', 'e a'].join('\n');
    const out = applyResultProjection(
      textResult(log),
      spec({
        pipe: [
          { op: 'grep', pattern: '^e ' },
          { op: 'sort' },
          { op: 'uniq', count: true },
          { op: 'head', n: 1 },
        ],
      }),
    );
    expect(bodyText(out)).toBe('      3 e a');
  });
});

describe('applyResultProjection — reporting', () => {
  it('the footer states the pipeline, the reduction, and the regex flavor', () => {
    const out = applyResultProjection(
      textResult(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')),
      spec({ pipe: [{ op: 'grep', pattern: 'line 9$' }] }),
      { toolName: 'capability:bash_output' },
    );
    const footer = footerOf(out);
    expect(footer).toContain('grep "line 9$"');
    expect(footer).toContain('of 100 lines');
    // The flavor is DECLARED, never assumed — P-021's replay harness reads this.
    expect(footer).toContain('JavaScript RegExp');
    expect(reportOf(out).regexFlavor).toBe('js-regexp');
  });

  it('a fixed-string grep claims no regex flavor', () => {
    const out = applyResultProjection(textResult('a\nb'), spec({ pipe: [{ op: 'grep', pattern: 'a', fixed: true }] }));
    expect(reportOf(out).regexFlavor).toBeUndefined();
    expect(footerOf(out)).not.toContain('JavaScript RegExp');
  });

  it('counts lines in and out in _meta', () => {
    const out = applyResultProjection(textResult('a\nb\nc'), spec({ pipe: [{ op: 'head', n: 2 }] }));
    expect(reportOf(out)).toMatchObject({ applied: true, linesIn: 3, linesOut: 2 });
  });
});

describe('applyResultProjection — pick (structured, D-041 tier 3)', () => {
  const body = JSON.stringify({
    results: [
      { id: 'WI-1', state: 'open', payload: { big: 'x'.repeat(200) } },
      { id: 'WI-2', state: 'done', payload: { big: 'y'.repeat(200) } },
    ],
    counts: { total: 2 },
  });

  it('selects fields and drops the rest', () => {
    const out = applyResultProjection(textResult(body), spec({ pick: ['results[].id', 'counts.total'] }));
    const parsed = JSON.parse(bodyText(out));
    expect(parsed).toEqual({ results: [{ id: 'WI-1' }, { id: 'WI-2' }], counts: { total: 2 } });
  });

  it('sibling paths stay CORRELATED on the same element, not two parallel arrays', () => {
    // A flat { path: value } map would return ids and states as separate arrays
    // the caller has to zip by position — and position is exactly the wrong key
    // to correlate a work-item list on (work_items:get says so explicitly).
    const out = applyResultProjection(textResult(body), spec({ pick: ['results[].id', 'results[].state'] }));
    expect(JSON.parse(bodyText(out))).toEqual({
      results: [
        { id: 'WI-1', state: 'open' },
        { id: 'WI-2', state: 'done' },
      ],
    });
  });

  it('selects events:status fields from their event_inspection root', () => {
    const eventStatus = JSON.stringify({
      ok: true,
      active_awaits: [{ event: 'gate:one', state: 'registered' }],
      recent_wakes: [],
      event_inspection: {
        current_generation: 1,
        current_state: 'declared',
        waiters: [{ await_id: 7, state: 'registered' }],
      },
    });

    const out = applyResultProjection(
      textResult(eventStatus),
      spec({ pick: ['event_inspection.current_generation', 'event_inspection.current_state', 'active_awaits'] }),
    );

    expect(JSON.parse(bodyText(out))).toEqual({
      active_awaits: [{ event: 'gate:one', state: 'registered' }],
      event_inspection: { current_generation: 1, current_state: 'declared' },
    });
  });

  it('selects work_items:get fields from nested workItem and row-level checkpoint roots', () => {
    const workItemsGet = JSON.stringify({
      ok: true,
      results: [
        {
          ok: true,
          id: 'EI-1',
          workItem: { state: 'open', assignee: 'su-1', title: 'first' },
          checkpoint: 'first checkpoint',
        },
        {
          ok: true,
          id: 'EI-2',
          workItem: { state: 'done', assignee: null, title: 'second' },
          checkpoint: 'second checkpoint',
        },
      ],
      counts: { ok: 2 },
    });

    const out = applyResultProjection(
      textResult(workItemsGet),
      spec({
        pick: [
          'results[].id',
          'results[].workItem.state',
          'results[].workItem.assignee',
          'results[].checkpoint',
        ],
      }),
    );

    expect(JSON.parse(bodyText(out))).toEqual({
      results: [
        { id: 'EI-1', workItem: { state: 'open', assignee: 'su-1' }, checkpoint: 'first checkpoint' },
        { id: 'EI-2', workItem: { state: 'done', assignee: null }, checkpoint: 'second checkpoint' },
      ],
    });
  });

  it('pick composes into pipe — the JSON is re-rendered as greppable lines', () => {
    const out = applyResultProjection(
      textResult(body),
      spec({ pick: ['results[].id'], pipe: [{ op: 'grep', pattern: 'WI-2' }] }),
    );
    expect(bodyText(out).trim()).toBe('"id": "WI-2"');
  });

  it('finds the JSON PAYLOAD item when advisory prose follows it (the live work_items:list shape)', () => {
    // Structured results are routinely two text items: the payload, then a
    // "See also:" routing hint. Joining them makes the whole thing unparseable,
    // so a naive parse reports "not JSON" against a body that visibly starts
    // `[{"id":…`. This is the shape that broke it live.
    const multi = {
      content: [
        { type: 'text' as const, text: JSON.stringify([{ id: 'WI-1', state: 'open', bulk: 'x'.repeat(500) }]) },
        { type: 'text' as const, text: 'See also: work_items:claimable (…routing hint…)' },
      ],
    };
    const out = applyResultProjection(multi, spec({ pick: ['[].id'] }));
    expect(JSON.parse(bodyText(out))).toEqual([{ id: 'WI-1' }]);
    expect(footerOf(out)).toContain('advisory text item(s)');
    expect(bodyText(out)).not.toContain('See also');
  });

  it('a NON-JSON body fails OPEN, and the reason reaches the in-band footer', () => {
    const out = applyResultProjection(textResult('just some log text'), spec({ pick: ['a.b'] }));
    expect(bodyText(out)).toBe('just some log text');
    expect(reportOf(out).notes.join(' ')).toContain('not JSON');
    // _meta alone is not enough — the footer is the copy the agent reads.
    expect(footerOf(out)).toContain('not JSON');
  });

  it('paths that match NOTHING leave the body unprojected rather than returning {}', () => {
    const out = applyResultProjection(textResult(body), spec({ pick: ['nope.missing'] }));
    expect(JSON.parse(bodyText(out))).toHaveProperty('counts');
    expect(footerOf(out)).toContain('matched NOTHING');
  });

  it('a partially-matching pick reports the misses but still projects', () => {
    const out = applyResultProjection(textResult(body), spec({ pick: ['results[].id', 'nope'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ results: [{ id: 'WI-1' }, { id: 'WI-2' }] });
    expect(footerOf(out)).toContain('nope');
  });
});

describe('parsePickPath / applyPick', () => {
  it('parses key, [] and [n] segments', () => {
    expect(parsePickPath('results[].payload.id')).toEqual([
      { kind: 'key', name: 'results' },
      { kind: 'array' },
      { kind: 'key', name: 'payload' },
      { kind: 'key', name: 'id' },
    ]);
    expect(parsePickPath('rows[0].id')).toEqual([
      { kind: 'key', name: 'rows' },
      { kind: 'index', i: 0 },
      { kind: 'key', name: 'id' },
    ]);
  });

  it('reports unmatched paths without throwing on a shape mismatch', () => {
    const { picked, unmatched } = applyPick({ a: 1 }, ['a', 'b[].c']);
    expect(picked).toEqual({ a: 1 });
    expect(unmatched).toEqual(['b[].c']);
  });

  it('omits unmatched wildcard elements instead of serializing them as null placeholders', () => {
    const body = {
      active: [{ ownerId: 'su-1', sessionState: 'parked' }],
      summary: { byState: { live: 0 } },
    };
    const { picked, unmatched } = applyPick(body, ['active[].state', 'summary.byState.live']);

    expect(unmatched).toEqual(['active[].state']);
    // An entirely unmatched path is omitted by the existing fail-open
    // contract; importantly, it must not manufacture `active: [null]`.
    expect(picked).toEqual({ summary: { byState: { live: 0 } } });
    expect(JSON.stringify(picked)).not.toContain('null');
  });

  it('keeps sibling wildcard paths correlated when one field is absent on a row', () => {
    const body = {
      rows: [
        { id: 'row-1' },
        { id: 'row-2', state: 'open' },
      ],
    };
    const { picked, unmatched } = applyPick(body, ['rows[].id', 'rows[].state']);

    expect(unmatched).toEqual([]);
    expect(picked).toEqual({ rows: [{ id: 'row-1' }, { id: 'row-2', state: 'open' }] });
  });
});

describe('applyResultProjection — safety contracts', () => {
  it('SKIPS a genuine delta ENVELOPE: reshaping it would corrupt the client-side parse', () => {
    const delta = {
      content: [{ type: 'text' as const, text: '{"delta":1}' }],
      _meta: { delta: { mode: 'delta', seq: 1 } },
    };
    const out = applyResultProjection(delta, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(out.content).toEqual(delta.content); // body untouched — no footer appended
    expect(reportOf(out)).toMatchObject({ applied: false });
    expect(reportOf(out).notes.join(' ')).toContain('delta');
  });

  it('still PROJECTS a delta-CAPABLE result whose body is normal (mode:"full")', () => {
    // Regression guard for the bug that live verification caught and every unit
    // test missed: every delta-capable tool stamps `_meta.delta` on ORDINARY
    // responses to advertise the capability and carry a cursor. Skipping on the
    // block's mere presence silently disabled the whole stage for every list
    // tool in the catalog. `mode` is the discriminator, not presence.
    const capable = {
      content: [{ type: 'text' as const, text: 'a\nb\nc' }],
      _meta: { delta: { mode: 'full', reason: 'no_request', itemKeyField: 'id' } },
    };
    const out = applyResultProjection(capable, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(bodyText(out)).toBe('a');
    expect(reportOf(out)).toMatchObject({ applied: true });
  });

  it('projects a proxy-RECONSTRUCTED full body too — it is plain JSON rows, not a patch', () => {
    const reconstructed = {
      content: [{ type: 'text' as const, text: '[{"id":"a"},{"id":"b"}]' }],
      _meta: { delta: { mode: 'full', reason: 'proxy_reconstructed' }, deltaProxy: { reconstructedFull: true } },
    };
    const out = applyResultProjection(reconstructed, spec({ pick: ['[].id'] }));
    expect(JSON.parse(bodyText(out))).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('keeps only the projected JSON object in structuredContent', () => {
    const source = { surface: 'public', hits: [{ title: 'FAQ', privateNoise: 'withheld' }], unselected: 'withheld' };
    const out = applyResultProjection(
      { ...textResult(JSON.stringify(source)), structuredContent: source },
      spec({ pick: ['surface', 'hits[].title'] }),
    );
    expect(out.structuredContent).toEqual({ surface: 'public', hits: [{ title: 'FAQ' }] });
    expect(out.structuredContent).toEqual(JSON.parse(bodyText(out)));
    expect(JSON.stringify(out)).not.toContain('withheld');
  });

  it('wraps a projected array in the serializer\'s object envelope', () => {
    const source = [{ id: 'a', noise: 'withheld' }, { id: 'b', noise: 'withheld' }];
    const out = applyResultProjection(
      { ...textResult(JSON.stringify(source)), structuredContent: { value: source } },
      spec({ pick: ['[].id'] }),
    );
    expect(out.structuredContent).toEqual({ value: [{ id: 'a' }, { id: 'b' }] });
    expect(JSON.stringify(out)).not.toContain('withheld');
  });

  it('drops structuredContent for a non-JSON line result and says so in the footer', () => {
    const withStructured = { ...textResult('a\nb\nc'), structuredContent: { everything: true } };
    const out = applyResultProjection(withStructured, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(out.structuredContent).toBeUndefined();
    expect(footerOf(out)).toContain('structuredContent dropped');
  });

  it('passes non-text content items through untouched', () => {
    const mixed = {
      content: [
        { type: 'text' as const, text: 'a\nb' },
        { type: 'image', data: 'zz' } as Record<string, unknown>,
      ],
    };
    const out = applyResultProjection(mixed, spec({ pipe: [{ op: 'head', n: 1 }] }));
    expect(out.content).toContainEqual({ type: 'image', data: 'zz' });
  });

  it('fail-soft: a malformed result never becomes a failure', () => {
    const broken = { content: 'not-an-array' as unknown as [] };
    expect(applyResultProjection(broken, spec({ pipe: [{ op: 'head', n: 1 }] }))).toBe(broken);
  });

  it('an empty result body projects to empty without throwing', () => {
    const out = applyResultProjection(textResult(''), spec({ pipe: [{ op: 'grep', pattern: 'x' }] }));
    expect(bodyText(out)).toBe('');
    expect(reportOf(out)).toMatchObject({ linesIn: 0, linesOut: 0 });
  });

  // EI-19944567995100280: a grep-shaped projection against an ERROR envelope used
  // to run normally, reducing a real `invalid_input` failure to 0 lines / 0 chars
  // — reported by the door footer as "(100% saved)", indistinguishable from a
  // successful filter that matched nothing. The caller read the empty body as
  // "no results" three times before discovering the call had failed all along.
  it('BYPASSES projection entirely on an isError result — the error text survives untouched', () => {
    const errorResult = {
      isError: true,
      content: [
        { type: 'text' as const, text: 'invalid_input: invalid_args: order: Invalid option: expected one of "updated"|"created"|"slug"' },
      ],
    };
    const out = applyResultProjection(
      errorResult,
      spec({ pipe: [{ op: 'grep', pattern: 'gate|ownership|red|condition' }, { op: 'head', n: 25 }] }),
    );
    // Untouched: no footer appended, no lines dropped, the original error text intact.
    expect(out.content).toEqual(errorResult.content);
    expect(bodyText(out)).toContain('invalid_input');
    expect(reportOf(out)).toMatchObject({ applied: false, linesIn: 0, linesOut: 0 });
    expect(reportOf(out).notes.join(' ')).toMatch(/error/i);
  });

  it('still bypasses on isError even when a `pick` would have matched nothing (not just non-JSON text)', () => {
    const errorResult = {
      isError: true,
      content: [{ type: 'text' as const, text: '{"error":"not_found","id":"WI-1"}' }],
    };
    const out = applyResultProjection(errorResult, spec({ pick: ['results[].id'] }));
    expect(out.content).toEqual(errorResult.content);
    expect(reportOf(out).applied).toBe(false);
  });

  it('retains a semantic write failure outcome when pick names only success fields', () => {
    const failedWrite = { ok: false, id: 'WI-1', error: 'not_found' };
    const out = applyResultProjection(
      textResult(JSON.stringify(failedWrite)),
      spec({ pick: ['id'] }),
      { effect: 'write' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({ id: 'WI-1', ok: false, error: 'not_found' });
    expect(footerOf(out)).toContain('write outcome retained implicitly');
  });

  it('retains top-level and per-row failure signals in a partial bulk write', () => {
    const partialWrite = {
      ok: true,
      results: [{ ok: false, id: 'WI-1', error: 'not_found' }],
      counts: { ok: 0, failed: 1 },
    };
    const out = applyResultProjection(
      textResult(JSON.stringify(partialWrite)),
      spec({ pick: ['results[].id'] }),
      { effect: 'write' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({
      ok: true,
      results: [{ id: 'WI-1', ok: false, error: 'not_found' }],
      counts: { ok: 0, failed: 1 },
    });
  });

  it('does not change read projection semantics', () => {
    const result = { ok: false, id: 'WI-1', error: 'not_found' };
    const out = applyResultProjection(
      textResult(JSON.stringify(result)),
      spec({ pick: ['id'] }),
      { effect: 'read' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({ id: 'WI-1' });
  });
});

/**
 * EI-19361771982678588 — a filter must be honest about what it was ALLOWED to search.
 *
 * This stage runs after the tool's own payload-tier bounding, and the result-door's
 * upstream-truncation warning is only reached when the result still exceeds the door
 * budget (result-door.ts:160). So a projection that shrinks the body under that budget
 * suppresses the sole notice that the corpus was partial — and a zero-hit grep then
 * reads as "no such value exists". Live cost: a `grep` over a facts:list trimmed from
 * 40 rows to 4 reported `0 of 3 lines`; four matching rows existed.
 */
describe('applyResultProjection — upstream truncation is disclosed (EI-19361771982678588)', () => {
  const truncated = (text: string, omittedCount = 69) => ({
    content: [{ type: 'text' as const, text }],
    _meta: { payloadProjection: { truncated: true, tier: 'trimmed', omittedCount } },
  });

  it('a ZERO-hit filter over a truncated corpus says it is NOT evidence of absence', () => {
    const out = applyResultProjection(
      truncated('alpha\nbeta\ngamma'),
      spec({ pipe: [{ op: 'grep', pattern: 'p011' }] }),
      { toolName: 'facts:list' },
    );
    const footer = footerOf(out);
    // The footer is the copy the agent reads — _meta alone would not have stopped this.
    expect(footer).toContain('NOT evidence of absence');
    expect(footer).toContain('ALREADY TRUNCATED');
    expect(footer).toContain('69');
    expect(footer).toContain('tier=trimmed');
    expect(footer).toContain("payloadTier:'full'");
    expect(footer).toContain('facts:list');
    expect(reportOf(out).linesOut).toBe(0);
  });

  it('a NON-empty projection over a truncated corpus still warns, but more weakly', () => {
    const out = applyResultProjection(
      truncated('alpha\nbeta p011\ngamma'),
      spec({ pipe: [{ op: 'grep', pattern: 'p011' }] }),
      { toolName: 'facts:list' },
    );
    const footer = footerOf(out);
    expect(footer).toContain('RETAINED portion only');
    expect(footer).toContain('ALREADY TRUNCATED');
    // The strong absence claim belongs ONLY to the zero-hit case.
    expect(footer).not.toContain('NOT evidence of absence');
  });

  it('the warning fires for ANY projection, not just grep — head hides the tail the same way', () => {
    const out = applyResultProjection(
      truncated('a\nb\nc\nd'),
      spec({ pipe: [{ op: 'head', n: 1 }] }),
      { toolName: 'work_items:list' },
    );
    expect(footerOf(out)).toContain('ALREADY TRUNCATED');
  });

  it('NO warning when the payload was never tier-truncated (no crying wolf)', () => {
    const out = applyResultProjection(
      textResult('alpha\nbeta'),
      spec({ pipe: [{ op: 'grep', pattern: 'nope' }] }),
      { toolName: 'facts:list' },
    );
    expect(footerOf(out)).not.toContain('ALREADY TRUNCATED');
    expect(reportOf(out).notes).toEqual([]);
  });

  it('NO warning when the marker is present but truncated is falsy', () => {
    const out = applyResultProjection(
      {
        content: [{ type: 'text' as const, text: 'alpha\nbeta' }],
        _meta: { payloadProjection: { truncated: false, tier: 'full', omittedCount: 0 } },
      },
      spec({ pipe: [{ op: 'grep', pattern: 'nope' }] }),
      { toolName: 'facts:list' },
    );
    expect(footerOf(out)).not.toContain('ALREADY TRUNCATED');
  });

  it('degrades gracefully when the marker omits its optional fields', () => {
    const out = applyResultProjection(
      { content: [{ type: 'text' as const, text: 'a' }], _meta: { payloadProjection: { truncated: true } } },
      spec({ pipe: [{ op: 'grep', pattern: 'zzz' }] }),
      {},
    );
    const footer = footerOf(out);
    expect(footer).toContain('NOT evidence of absence');
    expect(footer).toContain('tier=unknown');
    // No toolName supplied — the advice must still be actionable, never "undefined".
    expect(footer).not.toContain('undefined');
  });
});

describe('applyResultProjection — capability:read bounded windows are disclosed (EI-22600297478962145)', () => {
  it('warns when a projection searches only capability:read’s retained line window', () => {
    const boundedRead = [
      '/repo/long-file.ts (2556 lines, showing 1–2000)',
      '     1\tfirst line',
      '  2000\tlast retained line',
      '… [556 more lines — re-read with offset=2001]',
    ].join('\n');
    const out = applyResultProjection(
      textResult(boundedRead),
      spec({ pipe: [{ op: 'grep', pattern: 'judgeCanary' }] }),
      { toolName: 'capability:read' },
    );

    const footer = footerOf(out);
    expect(footer).toContain('bounded line window');
    expect(footer).toContain('NOT evidence of absence');
    expect(footer).toContain('offset named by the marker');
    expect(reportOf(out).notes.join(' ')).toContain('omitted lines were never searched');
  });

  it('does not warn for a complete line result without the read-window marker', () => {
    const out = applyResultProjection(
      textResult('/repo/short-file.ts (2 lines)\n     1\talpha\n     2\tbeta'),
      spec({ pipe: [{ op: 'grep', pattern: 'judgeCanary' }] }),
      { toolName: 'capability:read' },
    );

    expect(footerOf(out)).not.toContain('bounded line window');
    expect(reportOf(out).notes).toEqual([]);
  });
});

/**
 * P-015 — the footer's ORDER, not its numbers.
 *
 * The defect: the footer led with "(97% saved)" and put every caveat behind it,
 * so a `pick` that silently dropped the field the caller came for was headlined
 * by a success statistic. These assert the caveat comes FIRST, and that the
 * statistic stops calling itself a saving when the body cannot be trusted.
 *
 * The CONTROLs are the load-bearing half: an honest reduction must still render
 * the plain "saved" wording, or this fix would just be a louder footer on every
 * result — which trains the same ignoring it set out to cure.
 */
describe('applyResultProjection — degraded results lead with the caveat (P-015)', () => {
  const JSON_BODY = JSON.stringify({
    results: [
      { id: 'a', state: 'open' },
      { id: 'b', state: 'shut' },
    ],
  });

  it('CONTROL: an honest pick — every path matched — keeps "saved" and leads with the stats', () => {
    const out = applyResultProjection(textResult(JSON_BODY), spec({ pick: ['results[].id'] }));
    const footer = footerOf(out);
    expect(footer).toContain('saved)');
    expect(footer).not.toContain('of the body removed');
    // Nothing precedes the stats block: the footer opens with it.
    expect(footer.trimStart().startsWith('[projection:')).toBe(true);
    expect(reportOf(out).notes).toEqual([]);
  });

  it('a PARTIAL pick miss puts the warning ahead of the statistic', () => {
    const out = applyResultProjection(
      textResult(JSON_BODY),
      spec({ pick: ['results[].id', 'results[].nosuchfield'] }),
    );
    const footer = footerOf(out);
    const warnAt = footer.indexOf('matched nothing');
    const statAt = footer.indexOf('[projection:');
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(statAt).toBeGreaterThanOrEqual(0);
    // THE ASSERTION THIS FIX EXISTS FOR: caveat before number, not after.
    expect(warnAt).toBeLessThan(statAt);
    expect(footer).toContain('results[].nosuchfield');
    expect(footer).toContain('ABSENT');
  });

  it('a degraded result never calls its reduction a "saving"', () => {
    const footer = footerOf(
      applyResultProjection(
        textResult(JSON_BODY),
        spec({ pick: ['results[].id', 'results[].nosuchfield'] }),
      ),
    );
    expect(footer).toContain('of the body removed');
    expect(footer).not.toContain('saved)');
  });

  it('an EMPTY body says so before anything else — it is not an absence', () => {
    const out = applyResultProjection(
      textResult(['alpha', 'beta', 'gamma'].join('\n')),
      spec({ pipe: [{ op: 'grep', pattern: 'nomatch-zzq' }] }),
    );
    const footer = footerOf(out);
    expect(footer.trimStart().startsWith('⚠ THIS PROJECTION REMOVED EVERYTHING')).toBe(true);
    expect(footer).toContain('Do not read it as an absence');
    expect(footer).toContain('of the body removed');
  });

  it('CONTROL: a genuinely empty INPUT is not accused of being a filter artifact', () => {
    // linesIn === 0, so there was nothing to remove — the empty-lead must stay silent.
    const footer = footerOf(
      applyResultProjection(textResult(''), spec({ pipe: [{ op: 'head', n: 5 }] })),
    );
    expect(footer).not.toContain('REMOVED EVERYTHING');
  });

  it('a non-degrading note (structuredContent replaced) stays BELOW the statistic', () => {
    const out = applyResultProjection(
      { content: [{ type: 'text' as const, text: JSON_BODY }], structuredContent: { big: true } },
      spec({ pick: ['results[].id'] }),
    );
    const footer = footerOf(out);
    const noteAt = footer.indexOf('structuredContent replaced');
    const statAt = footer.indexOf('[projection:');
    expect(noteAt).toBeGreaterThan(statAt);
    // It is not a trust warning, so the saving is still a saving.
    expect(footer).toContain('saved)');
  });

  it('_meta.notes still carries every note as flat strings (the report shape is unchanged)', () => {
    const out = applyResultProjection(
      { content: [{ type: 'text' as const, text: JSON_BODY }], structuredContent: { big: true } },
      spec({ pick: ['results[].id', 'results[].nope'] }),
    );
    const notes = reportOf(out).notes;
    expect(notes.every((n) => typeof n === 'string')).toBe(true);
    expect(notes.some((n) => n.includes('matched nothing'))).toBe(true);
    expect(notes.some((n) => n.includes('structuredContent replaced'))).toBe(true);
  });
});

/**
 * EI-20720054720826414 — the array-root miss, and its two teeth.
 *
 * The single most common pick failure is a bare `key` path against an ARRAY-root
 * body (the playbook's own examples were object-root only). Before this fix the
 * all-miss fail-open left the FULL promoted body in place — LARGER than the
 * un-projected default — which then overflowed the door and spilled, and the
 * miss warning lived in a tail footer that the door's head-keeping truncation
 * deleted. So: (1) a provably-matching `[].key` respelling is applied instead of
 * failing, and (2) a degraded verdict leads the content where truncation cannot
 * reach it. The CONTROLS pin the negative space: object-root picks are never
 * reinterpreted, and a clean reduction keeps its tail footer.
 */
describe('applyResultProjection — array-root pick repair (EI-20720054720826414)', () => {
  const ARRAY_BODY = JSON.stringify([
    { id: 'WI-1', title: 't1', noise: 'x'.repeat(100) },
    { id: 'WI-2', title: 't2', noise: 'y'.repeat(100) },
  ]);

  it('auto-adjusts a bare key to [].key when the body is an array — and says so', () => {
    const out = applyResultProjection(textResult(ARRAY_BODY), spec({ pick: ['id', 'title'] }));
    expect(JSON.parse(bodyText(out))).toEqual([
      { id: 'WI-1', title: 't1' },
      { id: 'WI-2', title: 't2' },
    ]);
    const footer = footerOf(out);
    expect(footer).toContain('auto-adjusted');
    expect(footer).toContain('id → [].id');
    // The selection succeeded — a courtesy note, not a trust warning.
    expect(footer).toContain('saved)');
  });

  it('re-roots a keyed-array selector onto an array root when its row fields uniquely match', () => {
    const source = [{ slug: 'papercusp', path: '/harness/papercusp', privateNoise: 'withheld' }];
    const out = applyResultProjection(
      textResult(JSON.stringify(source)),
      spec({ pick: ['items[].slug', 'items[].path'] }),
    );

    expect(JSON.parse(bodyText(out))).toEqual([{ slug: 'papercusp', path: '/harness/papercusp' }]);
    expect(footerOf(out)).toContain('items[].slug → [].slug');
    expect(footerOf(out)).toContain('items[].path → [].path');
    expect(footerOf(out)).toContain('array-root paths start at each row');
  });

  it('does not guess between a row field and a nested keyed-array field', () => {
    const source = [{ slug: 'root', items: [{ slug: 'nested' }] }];
    const out = applyResultProjection(
      textResult(JSON.stringify(source)),
      spec({ pick: ['items[].slug'] }),
    );

    expect(JSON.parse(bodyText(out))).toEqual(source);
    expect(footerOf(out)).not.toContain('auto-adjusted');
    expect(footerOf(out)).toContain('items[].slug → [].items[].slug | [].slug');
    expect(footerOf(out)).toContain('more than one matches, so none was applied');
  });

  it('a repaired selection is NOT degraded: the verdict stays a tail footer', () => {
    const out = applyResultProjection(textResult(ARRAY_BODY), spec({ pick: ['id'] }));
    const texts = textsOf(out);
    expect(isVerdictText(texts[texts.length - 1])).toBe(true);
    expect(isVerdictText(texts[0])).toBe(false);
  });

  it('does NOT repair a path that would still miss — the miss stays loud, and names the shape', () => {
    const out = applyResultProjection(textResult(ARRAY_BODY), spec({ pick: ['zzz'] }));
    expect(JSON.parse(bodyText(out))).toHaveLength(2); // body left unprojected
    const footer = footerOf(out);
    expect(footer).toContain('matched NOTHING');
    expect(footer).toContain('an ARRAY of 2 element(s)');
    expect(footer).toContain('[].key');
  });

  it('CONTROL: never reinterprets a working path — an object-root pick is untouched by repair', () => {
    const objBody = JSON.stringify({ id: 'top', rows: [{ id: 'r1' }] });
    const out = applyResultProjection(textResult(objBody), spec({ pick: ['id'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ id: 'top' });
    expect(footerOf(out)).not.toContain('auto-adjusted');
  });

  it('mixed: repairs the missed spelling and keeps the already-correct one, correlated', () => {
    const out = applyResultProjection(textResult(ARRAY_BODY), spec({ pick: ['[].id', 'title'] }));
    expect(JSON.parse(bodyText(out))).toEqual([
      { id: 'WI-1', title: 't1' },
      { id: 'WI-2', title: 't2' },
    ]);
    expect(footerOf(out)).toContain('title → [].title');
  });

  it('an all-miss on an OBJECT root names the object keys — the corrective hint, no repair', () => {
    const out = applyResultProjection(
      textResult(JSON.stringify({ results: [{ id: 'a' }], counts: { total: 1 } })),
      spec({ pick: ['nope.missing'] }),
    );
    const footer = footerOf(out);
    expect(footer).toContain('an OBJECT with key(s): results, counts');
  });
});

describe('applyResultProjection — a degraded verdict LEADS the content (EI-20720054720826414)', () => {
  it('degraded ⇒ the verdict is the FIRST content item, ahead of the body it warns about', () => {
    // The delivery guarantee this fix exists for: downstream doors keep the HEAD
    // of an oversized serialized result, so a warning behind the body is deleted
    // exactly when the body is oversized — the all-miss fail-open case.
    const out = applyResultProjection(textResult(JSON.stringify({ a: 1 })), spec({ pick: ['nope'] }));
    const texts = textsOf(out);
    expect(texts[0]).toContain('matched NOTHING');
    expect(isVerdictText(texts[0])).toBe(true);
  });

  it('CONTROL: a clean reduction keeps the verdict as the LAST item', () => {
    const out = applyResultProjection(
      textResult(JSON.stringify({ rows: [{ id: 'x' }] })),
      spec({ pick: ['rows[].id'] }),
    );
    const texts = textsOf(out);
    expect(isVerdictText(texts[0])).toBe(false);
    expect(isVerdictText(texts[texts.length - 1])).toBe(true);
  });
});

/**
 * EI-20437640729173444 — projection must disclose the difference between
 * rendered line semantics and structured payload semantics, and must inspect
 * truncation markers before a pick/pipe stage can remove them.
 */
describe('applyResultProjection — structured-body and custom truncation disclosures (EI-20437640729173444)', () => {
  it('warns that pipe/count sees one rendered JSON line, not matching array items', () => {
    const body = JSON.stringify({
      results: [
        { id: 'WI-1', state: 'open' },
        { id: 'WI-2', state: 'open' },
        { id: 'WI-3', state: 'done' },
      ],
    });
    const out = applyResultProjection(
      textResult(body),
      spec({ pipe: [{ op: 'grep', pattern: 'state' }, { op: 'count' }] }),
      { toolName: 'work_items:list' },
    );

    // D-005: the compact JSON is re-rendered with indentation before the line
    // operators run, so grep keeps the three `"state"` lines and count reports
    // that RENDERED-LINE count. The footer must still say it is not an
    // item-level count.
    expect(bodyText(out)).toBe('3');
    const footer = footerOf(out);
    expect(footer).toContain('pipe applied directly to structured JSON');
    expect(footer).toContain('count` reports rendered line count, not matching item count');
    expect(footer).toContain('JSON on 1 line(s)');
    expect(footer).toContain('2-space indentation');
    expect(footer).toContain('Use `pick` first');
    expect(reportOf(out).notes.join(' ')).toContain('rendered JSON lines');
  });

  // oversized-tool-results-reduction-2026-10-12#D-005 / WI-6554700010010307:
  // over the compact rendering grep kept everything and head could not cut, so a
  // pipe never reduced a JSON result.
  it('lets grep select fields and head cut a compact JSON body (D-005)', () => {
    const body = JSON.stringify({
      results: [{ id: 'WI-1', workItem: { state: 'open', summary: 'x'.repeat(5_000) } }],
    });
    const grepped = applyResultProjection(
      textResult(body),
      spec({ pipe: [{ op: 'grep', pattern: '"state"' }] }),
      { toolName: 'work_items:get' },
    );
    expect(bodyText(grepped).trim()).toBe('"state": "open",');

    const headed = applyResultProjection(
      textResult(body),
      spec({ pipe: [{ op: 'head', n: 3 }] }),
      { toolName: 'work_items:get' },
    );
    expect(bodyText(headed).split('\n')).toEqual(['{', '  "results": [', '    {']);
  });

  it('re-renders only the JSON item when the body has other text items (D-005)', () => {
    expect(
      renderJsonForLineOps([{ text: 'header line' }, { text: '{"a":1}' }], { parsed: { a: 1 }, itemIndex: 1 }),
    ).toBe('header line\n\n{\n  "a": 1\n}');
    expect(renderJsonForLineOps([{ text: '[1]' }], { parsed: [1], itemIndex: -1 })).toBe('[\n  1\n]');
  });

  it('warns on a generic _projection truncation marker before pick removes it', () => {
    const body = JSON.stringify({
      results: [{ id: 'WI-1' }, { id: 'WI-2' }],
      _projection: { truncated: true, omittedCount: 4 },
    });
    const out = applyResultProjection(
      textResult(body),
      spec({ pick: ['results[].id'] }),
      { toolName: 'work_items:list' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({ results: [{ id: 'WI-1' }, { id: 'WI-2' }] });
    const footer = footerOf(out);
    expect(footer).toContain('field-level/custom-shaper truncation');
    expect(footer).toContain('$._projection.truncated');
    expect(footer).toContain("re-call work_items:list with payloadTier:'full'");
    expect(reportOf(out).notes.join(' ')).toContain('omitted fields/items were never serialized');
  });

  it('does not recommend payloadTier full as a source-page widening for facts:list', () => {
    const body = JSON.stringify({
      count: 4,
      total: 26,
      truncatedByLimit: true,
      facts: [{ key: 'dead-end:example', body: 'excerpt', body_truncated: true }],
    });
    const out = applyResultProjection(
      textResult(body),
      spec({ pick: ['facts[].key'] }),
      { toolName: 'facts:list' },
    );

    const note = reportOf(out).notes.join(' ');
    expect(note).toContain("payloadTier:'full' changes response shaping");
    expect(note).toContain('does not widen the source query');
    expect(note).toContain('count/total/truncation fields');
    expect(note).toContain('page-widening/pagination argument');
    expect(note).not.toContain("re-call facts:list with payloadTier:'full'");
  });

  it('warns on field-level and custom-shaper truncation markers', () => {
    const body = JSON.stringify({
      rows: [{ id: 'WI-1', title: 'retained', rankScore: 22.2 }],
      order: { by: 'rankScore', direction: 'desc' },
      fieldTruncated: true,
      truncatedByBudget: true,
    });
    const out = applyResultProjection(
      textResult(body),
      spec({ pick: ['rows[].id'] }),
      { toolName: 'work_items:list' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({ rows: [{ id: 'WI-1' }] });
    const footer = footerOf(out);
    expect(footer).toContain('$.fieldTruncated');
    expect(footer).toContain('$.truncatedByBudget');
    expect(footer).toContain('field-level/custom-shaper truncation');
    expect(reportOf(out).notes).toHaveLength(1);
  });

  it('frames an order-bearing retained window as a biased ranking head, not a representative sample', () => {
    const body = JSON.stringify({
      rows: [
        { id: 'gate-high', decision: 'gate', rankScore: 22.2 },
        { id: 'gate-next', decision: 'gate', rankScore: 12.8 },
      ],
      order: { by: 'rankScore', direction: 'desc' },
      rowsTruncated: true,
    });
    const out = applyResultProjection(
      textResult(body),
      spec({ pick: ['rows[].decision'] }),
      { toolName: 'improvements:triage' },
    );

    const note = reportOf(out).notes.join(' ');
    expect(note).not.toMatch(/\bsample\b/i);
    expect(note).toContain('HEAD of a ranking');
    expect(note).toContain('not a representative slice');
    expect(note).toContain('is a floor');
    expect(note).toContain('systematically');
    expect(note).toContain('skewed');
  });

  it('warns when pick drops non-empty selection partiality metadata', () => {
    const body = JSON.stringify({
      results: [{ decisions: [{ id: 'D-007', title: 'one' }] }],
      decisionSelection: {
        requested: ['D-005', 'D-006', 'D-007'],
        matched: ['D-005', 'D-006', 'D-007'],
        missing: [],
        returned: ['D-005', 'D-006'],
        deferred: ['D-007'],
      },
    });
    const out = applyResultProjection(
      textResult(body),
      spec({ pick: ['results[].decisions[].id', 'results[].decisions[].title'] }),
      { toolName: 'plans:get' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({
      results: [{ decisions: [{ id: 'D-007', title: 'one' }] }],
    });
    const footer = footerOf(out);
    expect(footer).toContain('partial-result metadata');
    expect(footer).toContain('$.decisionSelection.deferred');
    expect(footer).toContain('not a complete population finding');
    expect(footer).toContain("payloadTier:'full'");
    expect(reportOf(out).notes.join(' ')).toContain('pick may also have dropped the marker itself');
  });

  it('does not warn for an empty selection partiality field', () => {
    const body = JSON.stringify({
      results: [{ decisions: [{ id: 'D-007', title: 'one' }] }],
      decisionSelection: {
        requested: ['D-007'],
        matched: ['D-007'],
        missing: [],
        returned: ['D-007'],
        deferred: [],
      },
    });
    const out = applyResultProjection(
      textResult(body),
      spec({ pick: ['results[].decisions[].id'] }),
      { toolName: 'plans:get' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({
      results: [{ decisions: [{ id: 'D-007' }] }],
    });
    expect(reportOf(out).notes).toEqual([]);
  });

  it.each([
    {
      name: 'false generic marker',
      body: { rows: [{ id: 'WI-1' }], _projection: { truncated: false } },
    },
    {
      name: 'false field marker',
      body: { rows: [{ id: 'WI-1' }], fieldTruncated: false, payloadTierForced: false },
    },
    {
      name: 'ordinary truncation prose',
      body: { rows: [{ id: 'WI-1' }], note: 'This report describes truncation policy.' },
    },
  ])('$name does not cry wolf', ({ body }) => {
    const out = applyResultProjection(
      textResult(JSON.stringify(body)),
      spec({ pick: ['rows[].id'] }),
      { toolName: 'work_items:list' },
    );

    expect(JSON.parse(bodyText(out))).toEqual({ rows: [{ id: 'WI-1' }] });
    expect(footerOf(out)).not.toContain('field-level/custom-shaper truncation');
    expect(reportOf(out).notes).toEqual([]);
  });
});

/**
 * WI-10002073 — the projection ROOT is not uniform across tools.
 *
 * The three roots below are not invented: they were MEASURED in one task against
 * the running operator — `plans:get` answers under `results[]`,
 * `plans:get-spec-evidence` under `evidence[]`, and `work_items:get` under
 * `results[].workItem`. Nothing in a tool's schema announces which, so a path
 * correct for one tool silently matches nothing on another and the only recovery
 * was a second round-trip.
 *
 * EI-20720054720826414 already established the safe shape of a repair for the
 * ARRAY-root case; this extends it to keyed envelopes under the same two teeth
 * (only a MISSED path is rewritten; only a PROVABLY matching rewrite is applied)
 * plus a third the object-root case needs: when SEVERAL spellings match, NONE is
 * applied, because a wrong guess is a SILENT wrong read — strictly worse than the
 * miss it replaces.
 *
 * The CONTROLS carry the weight here. A repair engine is only as trustworthy as
 * its negative space, so the ambiguity case, the genuine miss, and the
 * never-reinterpret-a-working-path case are each pinned explicitly.
 */
describe('applyResultProjection — keyed-envelope pick repair (WI-10002073)', () => {
  // Real shapes, trimmed: work_items:get nests the row a level deeper than the
  // envelope key, which is the miss no key-list in an error message can fix.
  const WORK_ITEMS_GET = JSON.stringify({
    ok: true,
    results: [{ id: 'WI-1', workItem: { state: 'open', title: 't1' } }],
  });
  const SPEC_EVIDENCE = JSON.stringify({
    ok: true,
    slug: 'a-plan',
    harnessSlug: 'papercusp',
    evidence: [{ id: 'ev-1', kind: 'code' }],
    count: 1,
  });

  it('repairs a path that stops one level short of the row (work_items:get)', () => {
    const out = applyResultProjection(textResult(WORK_ITEMS_GET), spec({ pick: ['results[].state'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ results: [{ workItem: { state: 'open' } }] });
    const footer = footerOf(out);
    expect(footer).toContain('auto-adjusted');
    expect(footer).toContain('results[].state → results[].workItem.state');
    expect(footer).toContain('keyed-envelope');
  });

  it('repairs a path that names the WRONG envelope key (plans:get-spec-evidence)', () => {
    const out = applyResultProjection(textResult(SPEC_EVIDENCE), spec({ pick: ['results[].id'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ evidence: [{ id: 'ev-1' }] });
    expect(footerOf(out)).toContain('results[].id → evidence[].id');
  });

  it('repairs a bare [].key path used against a keyed envelope', () => {
    const out = applyResultProjection(textResult(SPEC_EVIDENCE), spec({ pick: ['[].kind'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ evidence: [{ kind: 'code' }] });
    expect(footerOf(out)).toContain('[].kind → evidence[].kind');
  });

  it('a repaired selection is NOT degraded: the verdict stays a tail footer', () => {
    const texts = textsOf(
      applyResultProjection(textResult(SPEC_EVIDENCE), spec({ pick: ['results[].id'] })),
    );
    expect(isVerdictText(texts[texts.length - 1])).toBe(true);
    expect(isVerdictText(texts[0])).toBe(false);
  });

  it('mixed: repairs the wrong-rooted path and keeps the already-correct one', () => {
    const out = applyResultProjection(
      textResult(WORK_ITEMS_GET),
      spec({ pick: ['results[].id', 'results[].state'] }),
    );
    expect(JSON.parse(bodyText(out))).toEqual({
      results: [{ id: 'WI-1', workItem: { state: 'open' } }],
    });
    expect(footerOf(out)).toContain('results[].state → results[].workItem.state');
  });

  it('CONTROL: AMBIGUOUS — two spellings match, so NEITHER is applied; both are named', () => {
    const body = JSON.stringify({ rows: [{ id: 'from-rows' }], extras: [{ id: 'from-extras' }] });
    const out = applyResultProjection(textResult(body), spec({ pick: ['results[].id'] }));
    // Body left unprojected: guessing between them would be a silent wrong read.
    expect(JSON.parse(bodyText(out))).toEqual({
      rows: [{ id: 'from-rows' }],
      extras: [{ id: 'from-extras' }],
    });
    const footer = footerOf(out);
    expect(footer).not.toContain('auto-adjusted');
    expect(footer).toContain('matched NOTHING');
    expect(footer).toContain('WOULD match');
    expect(footer).toContain('rows[].id');
    expect(footer).toContain('extras[].id');
  });

  it('CONTROL: a genuine miss stays a loud miss and names the body shape', () => {
    const out = applyResultProjection(textResult(SPEC_EVIDENCE), spec({ pick: ['results[].zzz'] }));
    const footer = footerOf(out);
    expect(footer).toContain('matched NOTHING');
    expect(footer).not.toContain('auto-adjusted');
    expect(footer).not.toContain('WOULD match');
    expect(footer).toContain('an OBJECT with key(s)');
    expect(footer).toContain('evidence');
  });

  it('CONTROL: never reinterprets a WORKING path — a top-level hit wins over a row hit', () => {
    // `id` resolves at the root, so it is not a miss and repair must not run —
    // otherwise the caller silently receives the ROW's id instead of the root's.
    const body = JSON.stringify({ id: 'top', results: [{ id: 'row' }] });
    const out = applyResultProjection(textResult(body), spec({ pick: ['id'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ id: 'top' });
    expect(footerOf(out)).not.toContain('auto-adjusted');
  });
});

/**
 * The repair primitives, unit-level. These are the falsifiability controls for
 * the block above: the engine's promise is "generate broadly, apply only what is
 * PROVEN", so the tests that matter assert what it REFUSES to propose.
 */
describe('pick repair primitives (WI-10002073)', () => {
  it('pickPathTail strips whichever envelope segment is present, and nothing else', () => {
    expect(pickPathTail('results[].workItem.state')).toBe('workItem.state');
    expect(pickPathTail('[].id')).toBe('id');
    expect(pickPathTail('id')).toBe('id'); // already a tail — unchanged
    expect(pickPathTail('a.b.c')).toBe('a.b.c'); // no envelope segment — unchanged
  });

  it('candidates never include the path the caller already wrote', () => {
    const body = { results: [{ id: 'x' }] };
    expect(pickRepairCandidates(body, 'results[].id')).not.toContain('results[].id');
  });

  it('proposes nothing for an array root beyond the [].key respelling', () => {
    expect(pickRepairCandidates([{ id: 'x' }], 'id')).toEqual(['[].id']);
    // Already correctly spelled for an array root — nothing to propose.
    expect(pickRepairCandidates([{ id: 'x' }], '[].id')).toEqual([]);
  });

  it('CALIBRATION + CONTROL: proposes for a real re-root, refuses when the leaf is absent', () => {
    const body = { evidence: [{ id: 'ev-1' }] };
    // Calibration: the mechanism does fire on a body it should repair.
    expect(proposePickRepairs(body, ['results[].id'], []).repairs.get('results[].id')).toBe(
      'evidence[].id',
    );
    // Control: same body, a leaf that exists NOWHERE — no repair, no ambiguity.
    const absent = proposePickRepairs(body, ['results[].nope'], []);
    expect(absent.repairs.size).toBe(0);
    expect(absent.ambiguous.size).toBe(0);
  });

  it('CONTROL: a candidate already in the caller selection is not offered as a repair', () => {
    const body = { evidence: [{ id: 'ev-1', kind: 'code' }] };
    const out = proposePickRepairs(body, ['results[].id'], ['evidence[].id']);
    expect(out.repairs.size).toBe(0);
  });

  it('CONTROL: two matching candidates are reported as ambiguous, never repaired', () => {
    const body = { rows: [{ id: 'a' }], extras: [{ id: 'b' }] };
    const out = proposePickRepairs(body, ['results[].id'], []);
    expect(out.repairs.size).toBe(0);
    expect(out.ambiguous.get('results[].id')).toEqual(['rows[].id', 'extras[].id']);
  });
});

// ── EI-23774219620725180: a pick-miss on a LARGE body REFUSES with the key list ──
//
// The old behaviour failed open into the FULL body, so a caller who passed a
// projection precisely BECAUSE the body was large paid the whole cost for a typo.
describe('applyResultProjection — pick-miss REFUSAL on a large body (EI-23774219620725180)', () => {
  // Shaped like the measured case: events:catalog has a real `families` key, the
  // caller guessed leaf names (`name`) that do not exist.
  const bigCatalog = JSON.stringify({
    ok: true,
    count: 40,
    families: Array.from({ length: 40 }, (_, i) => ({
      family: `fam-${i}`,
      keyPatterns: Array.from({ length: 6 }, (_, k) => `family.${i}.pattern.${k}.${'x'.repeat(30)}`),
      emitters: [`emitter-${i}`],
    })),
  });
  const ROOT_KEYS = ['ok (boolean)', 'count (number)', 'families (array[40])'];

  it('REFUSES: the 61KB-class body is withheld, the caller gets a bounded key list', () => {
    expect(bigCatalog.length).toBeGreaterThan(PICK_MISS_FAIL_OPEN_MAX_CHARS * 2);
    const out = applyResultProjection(
      textResult(bigCatalog),
      spec({ pick: ['families[].name', 'families[].keys'] }),
    );
    const body = bodyText(out);
    // Bounded: a small fraction of the original, never the full dump.
    expect(body.length).toBeLessThan(bigCatalog.length / 3);
    expect(body).not.toContain('pattern.39.');
    const refusal = JSON.parse(body) as Record<string, any>;
    expect(refusal.projection_refused).toBe('pick_matched_nothing');
    expect(refusal.requested_pick).toEqual(['families[].name', 'families[].keys']);
    expect(refusal.body_chars_withheld).toBe(bigCatalog.length);
    expect(refusal.root_keys).toEqual(ROOT_KEYS);
  });

  it('names the LEAF keys under the segment that DID match — the common typo (good prefix, bad leaf)', () => {
    const out = applyResultProjection(textResult(bigCatalog), spec({ pick: ['families[].name'] }));
    const refusal = JSON.parse(bodyText(out)) as Record<string, any>;
    expect(refusal.near_misses).toEqual([
      {
        path: 'families[].name',
        matchedPrefix: 'families[]',
        keysThere: ['family (string)', 'keyPatterns (array[6])', 'emitters (array[1])'],
      },
    ]);
  });

  it('names the wrong-shape hint when a key is addressed on an ARRAY without `[]`', () => {
    const out = applyResultProjection(textResult(bigCatalog), spec({ pick: ['families.family'] }));
    const refusal = JSON.parse(bodyText(out)) as Record<string, any>;
    expect(refusal.near_misses[0].matchedPrefix).toBe('families[]');
    expect(refusal.near_misses[0].hint).toContain('families[].family');
  });

  it('stays LOUD: the degraded verdict still leads the content and says the body was withheld', () => {
    const out = applyResultProjection(textResult(bigCatalog), spec({ pick: ['families[].name'] }));
    const texts = textsOf(out);
    expect(isVerdictText(texts[0])).toBe(true);
    expect(texts[0]).toContain('matched NOTHING');
    expect(texts[0]).toContain('WITHHELD');
    expect(reportOf(out).notes.join(' ')).toContain('WITHHELD');
  });

  it('is never an EMPTY object — the refusal cannot be mistaken for a filter that worked', () => {
    const out = applyResultProjection(textResult(bigCatalog), spec({ pick: ['zzz'] }));
    const refusal = JSON.parse(bodyText(out)) as Record<string, unknown>;
    expect(Object.keys(refusal).length).toBeGreaterThan(3);
    expect(refusal).toHaveProperty('projection_refused');
  });

  it('a first segment that matches NOTHING reports root keys only (no near-miss to invent)', () => {
    const out = applyResultProjection(textResult(bigCatalog), spec({ pick: ['nope.missing'] }));
    const refusal = JSON.parse(bodyText(out)) as Record<string, unknown>;
    expect(refusal).not.toHaveProperty('near_misses');
    expect(refusal.root_keys).toEqual(ROOT_KEYS);
  });

  it('an ARRAY-root body is described by its ROW keys', () => {
    const rows = JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({ id: `WI-${i}`, title: 't'.repeat(60), state: 'open' })),
    );
    expect(rows.length).toBeGreaterThan(PICK_MISS_FAIL_OPEN_MAX_CHARS);
    const out = applyResultProjection(textResult(rows), spec({ pick: ['zzz'] }));
    const refusal = JSON.parse(bodyText(out)) as Record<string, unknown>;
    expect(refusal.row_keys).toEqual(['id (string)', 'title (string)', 'state (string)']);
    expect(refusal).not.toHaveProperty('root_keys');
  });

  it('a WRITE keeps its outcome observable even when the pick missed (the implicit retention survives)', () => {
    const writeBody = JSON.stringify({
      ok: true,
      counts: { ok: 1, failed: 0 },
      detail: 'd'.repeat(PICK_MISS_FAIL_OPEN_MAX_CHARS + 500),
    });
    const out = applyResultProjection(textResult(writeBody), spec({ pick: ['nope'] }), {
      effect: 'write',
    });
    const refusal = JSON.parse(bodyText(out)) as Record<string, any>;
    expect(refusal.projection_refused).toBe('pick_matched_nothing');
    expect(refusal.write_outcome_retained).toEqual({ ok: true, counts: { ok: 1, failed: 0 } });
  });

  it('CONTROL: a body AT OR UNDER the budget still fails open unprojected (cheaper than the refusal)', () => {
    const small = JSON.stringify({ ok: true, rows: [{ id: 'a' }] });
    expect(small.length).toBeLessThanOrEqual(PICK_MISS_FAIL_OPEN_MAX_CHARS);
    const out = applyResultProjection(textResult(small), spec({ pick: ['nope'] }));
    expect(JSON.parse(bodyText(out))).toEqual({ ok: true, rows: [{ id: 'a' }] });
    expect(footerOf(out)).toContain('body left unprojected');
    expect(footerOf(out)).not.toContain('WITHHELD');
  });

  it('CONTROL: a pick that MATCHES is untouched on a large body — the refusal is a miss-only branch', () => {
    const out = applyResultProjection(textResult(bigCatalog), spec({ pick: ['families[].family'] }));
    const body = JSON.parse(bodyText(out)) as { families: Array<{ family: string }> };
    expect(body.families).toHaveLength(40);
    expect(body.families[0]).toEqual({ family: 'fam-0' });
    expect(bodyText(out)).not.toContain('projection_refused');
  });

  it('CONTROL: a PARTIAL miss on a large body still projects (only the all-miss refuses)', () => {
    const out = applyResultProjection(
      textResult(bigCatalog),
      spec({ pick: ['families[].family', 'families[].name'] }),
    );
    const body = JSON.parse(bodyText(out)) as { families: Array<{ family: string }> };
    expect(body.families).toHaveLength(40);
    expect(bodyText(out)).not.toContain('projection_refused');
    expect(footerOf(out)).toContain('matched nothing: families[].name');
  });

  it('CONTROL: the ambiguity hint (candidate spellings) still rides in the verdict on a refusal', () => {
    const body = JSON.stringify({
      rows: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, pad: 'p'.repeat(40) })),
      extras: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, pad: 'p'.repeat(40) })),
    });
    const out = applyResultProjection(textResult(body), spec({ pick: ['results[].id'] }));
    expect(footerOf(out)).toContain('WOULD match');
    expect(footerOf(out)).toContain('rows[].id');
    expect(footerOf(out)).toContain('WITHHELD');
  });
});

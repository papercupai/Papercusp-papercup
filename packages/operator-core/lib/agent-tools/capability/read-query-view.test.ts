/**
 * WI-6554700010008917 — make a searched spill as readable as a file: multi-line strings are
 * expanded into real lines, and `view_lines` reads a range of the SAME view a query searched
 * (the grep → sed workflow), refusing an out-of-range window instead of answering empty.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MULTILINE_FENCE,
  QUERY_OUTPUT_CHAR_BUDGET,
  querySavedResult,
  readSavedResultLines,
  renderJsonView,
  searchableView,
} from './read-query';
import readTool from './read';

const buf = (s: string) => Buffer.from(s, 'utf8');
const decision = ['Date: 2026-08-10', 'RULE: canonical is Postgres.', 'Applied:', '- plans -> no projection'].join('\n');
const plan = { slug: 'p', decisions: [{ id: 'D-001', title: 'short', body: decision }, { id: 'D-002', body: 'one line' }], tags: [], meta: {} };

describe('renderJsonView', () => {
  it('is byte-identical to JSON.stringify(v, null, 1) when no string contains a newline', () => {
    const v = { a: 1, b: [true, null, 'x', { c: [] }], d: {}, 'q"k': -2.5e-7, e: [[1, 2], []] };
    expect(renderJsonView(v)).toEqual(JSON.stringify(v, null, 1).split('\n'));
  });

  it('expands a multi-line string into its decoded lines between fences, keeping key, indent and comma', () => {
    const lines = renderJsonView(plan);
    const open = lines.indexOf(`   "body": ${MULTILINE_FENCE}`);
    expect(open).toBeGreaterThan(0);
    expect(lines.slice(open + 1, open + 5)).toEqual(decision.split('\n'));
    expect(lines[open + 5]).toBe(`   ${MULTILINE_FENCE}`);
    expect(renderJsonView(['a\nb', 'c'])).toEqual(['[', ` ${MULTILINE_FENCE}`, 'a', 'b', ` ${MULTILINE_FENCE},`, ' "c"', ']']);
  });
});

describe('query over the readable view', () => {
  it('a hit inside a multi-line string returns that sentence with its real neighbouring lines', () => {
    const r = querySavedResult(buf(JSON.stringify(plan)), { query: 'canonical postgres', context: 1 });
    expect(r.view).toBe('json-pretty');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].text).toBe('RULE: canonical is Postgres.');
    expect(r.matches[0].before).toEqual(['Date: 2026-08-10']);
    expect(r.matches[0].after).toEqual(['Applied:']);
  });
});

describe('readSavedResultLines', () => {
  it('reads lines of the same view a query searched, with the line numbers the query reported', () => {
    const payload = buf(JSON.stringify(plan));
    const hit = querySavedResult(payload, { query: 'canonical' }).matches[0].line;
    const r = readSavedResultLines(payload, { offset: hit - 1, limit: 3 });
    if (!r.ok) throw new Error('expected a window');
    const { lines } = searchableView(payload);
    expect(r.lines).toEqual([hit - 1, hit, hit + 1].map((n) => `${n}\t${lines[n - 1]}`));
    expect(r).toMatchObject({ startLine: hit - 1, endLine: hit + 1, totalLines: lines.length, nextOffset: hit + 2 });
  });

  it('refuses an offset past the end of the view instead of returning an empty window', () => {
    const payload = buf(JSON.stringify(plan));
    const total = searchableView(payload).lines.length;
    expect(readSavedResultLines(payload, { offset: total + 1 })).toMatchObject({ ok: false, reason: 'view_window_out_of_range', totalLines: total });
    expect(readSavedResultLines(payload, { offset: total })).toMatchObject({ ok: true, startLine: total, endLine: total, nextOffset: null });
  });

  it('stops at the output budget and points at the next unread line; a huge line is clipped, not dropped', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'y'.repeat(60)}`).join('\n');
    const r = readSavedResultLines(buf(text), { offset: 1, limit: 300 });
    if (!r.ok) throw new Error('expected a window');
    expect(r.lines.join('\n').length).toBeLessThanOrEqual(QUERY_OUTPUT_CHAR_BUDGET);
    expect(r.nextOffset).toBe(r.endLine + 1);
    const long = readSavedResultLines(buf(`x\n${'z'.repeat(5000)}`), { offset: 2 });
    expect(long).toMatchObject({ ok: true, clippedLines: 1, endLine: 2 });
  });
});

describe('capability:read { view_lines } (the tool surface)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'papercusp-read-view-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = () => ({ projectDir: dir, workspaceId: 'ws-view', isSuperuser: true, uiClientId: 'owner-view' }) as never;
  const call = async (args: Record<string, unknown>) =>
    ((await readTool.handler(args as never, ctx())) as { content: Array<{ text: string }>; isError?: boolean });

  it('query hands back a read_around cursor whose view_lines window contains the hit', async () => {
    const file = join(dir, 'spill.json');
    writeFileSync(file, JSON.stringify(plan));
    const q = JSON.parse((await call({ file_path: file, query: 'canonical' })).content[0].text);
    expect(q.read_around.args.view_lines.offset).toBeLessThanOrEqual(q.matches[0].line);
    const w = await call(q.read_around.args);
    expect(w.content[0].text).toContain('searched json-pretty view');
    expect(w.content[0].text).toContain(`${q.matches[0].line}\tRULE: canonical is Postgres.`);
  });

  it('refuses view_lines past the end, and refuses mixing it with another mode', async () => {
    const file = join(dir, 'spill.json');
    writeFileSync(file, JSON.stringify(plan));
    const past = await call({ file_path: file, view_lines: { offset: 10_000 } });
    expect(past.content[0].text).toContain('view_window_out_of_range');
    const mixed = await call({ file_path: file, view_lines: { offset: 1 }, query: 'x' });
    expect(mixed.content[0].text).toMatch(/mixed_window_modes|invalid/i);
  });
});

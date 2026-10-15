/**
 * token-efficiency-prompts-cache-and-behavior-2026-10-11 P-005 — the saved-result query over REAL
 * result-door spills. Clauses: SPEC-P-005, SPEC-P-005-NOMATCH, SPEC-P-005-TAIL, SPEC-P-005-REFUSED,
 * AUTO-BAR-R-5-P-005 and AUTO-BAR-R-10-P-005.
 *
 * FIXTURE CALIBRATION. Each `__fixtures__/token-eff-spill-*.scratch.md` is a byte-for-byte copy of a
 * spill that the production result door wrote on this box. They were captured on 2026-10-12 from
 * ~/.papercusp/scratch/papercusp-workspace/:
 *   - large-json          a plans:evaluate-spec-test-adequacy spill. The file is 1,356,704 bytes and
 *                         the payload 1,356,189 bytes. Its header records that no upstream truncation
 *                         marker was detected.
 *   - upstream-truncated  a work_items:get spill whose header says the tool itself already
 *                         truncated fields (bodyTruncated, textTruncated).
 *   - text                a code:run spill in toon text, not JSON. Its last line has no trailing
 *                         newline.
 * `parseScratchReference` recomputes the payload SHA-256 and refuses a mismatch. The calibration
 * test therefore proves each fixture is exactly what the producer wrote, including the envelope,
 * the manifest's body offset, the header lines and the upstream-truncation markers. It also proves
 * that one flipped byte is refused. The expected line numbers come from a plain line filter in this
 * file, computed over the header lines plus the re-serialized JSON body, not from read-query.ts.
 * The handler cases go through `capability:read` itself, with the clock pinned inside each
 * fixture's recorded validity window.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS } from '../../context-doors';

const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { parseScratchReference, ScratchReferenceError, writeScratchReference } from '../../scratch-reference';
import { QUERY_DEFAULT_CONTEXT, QUERY_MAX_LINE_CHARS, querySavedResult } from './read-query';
import readTool from './read';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const FIXTURE_FILES = {
  large: 'token-eff-spill-large-json.scratch.md',
  truncated: 'token-eff-spill-upstream-truncated.scratch.md',
  text: 'token-eff-spill-text.scratch.md',
} as const;
type FixtureName = keyof typeof FIXTURE_FILES;

function load(name: FixtureName) {
  const bytes = readFileSync(join(FIXTURES, FIXTURE_FILES[name]));
  const parsed = parseScratchReference(bytes);
  if (!parsed) throw new Error(`${FIXTURE_FILES[name]} is not a scratch reference`);
  return { bytes, manifest: parsed.manifest, payload: parsed.payload };
}

/**
 * The lines a saved-result query should search, computed WITHOUT read-query.ts. For a JSON body
 * the view is the spill header (its trailing blank separator lines dropped), then the body
 * re-serialized with one-space indentation. For a text body it is the raw lines.
 */
function oracleLines(name: FixtureName): string[] {
  const { manifest, payload } = load(name);
  const offset = manifest.bodyOffsetInPayload;
  if (offset === undefined) return payload.toString('utf8').split('\n');
  const header = payload.subarray(0, offset).toString('utf8').replace(/\n+$/, '').split('\n');
  const body = JSON.parse(payload.subarray(offset).toString('utf8')) as unknown;
  return [...header, ...expandMultilineStrings(JSON.stringify(body, null, 1).split('\n'))];
}

/**
 * WI-6554700010008917 oracle, derived from JSON.stringify's own output and not from read-query.ts:
 * a line whose whole value is a string containing a newline becomes `<indent><key>"""`, the
 * decoded lines, then `<indent>"""<comma>`.
 */
function expandMultilineStrings(lines: string[]): string[] {
  const valueLine = /^(\s*)("(?:[^"\\]|\\.)*": )?("(?:[^"\\]|\\.)*")(,?)$/;
  return lines.flatMap((line) => {
    const m = valueLine.exec(line);
    if (!m) return [line];
    const decoded = JSON.parse(m[3]) as string;
    if (!decoded.includes('\n')) return [line];
    return [`${m[1]}${m[2] ?? ''}"""`, ...decoded.split('\n'), `${m[1]}"""${m[4]}`];
  });
}

const linesContaining = (lines: string[], term: string) =>
  lines.flatMap((line, i) => (line.toLowerCase().includes(term.toLowerCase()) ? [i + 1] : []));

/** Every page a caller must read to see all matches. */
function allPages(name: FixtureName, query: string) {
  const { manifest, payload } = load(name);
  const pages: ReturnType<typeof querySavedResult>[] = [];
  let fromLine: number | undefined;
  do {
    const page = querySavedResult(payload, {
      query,
      bodyOffset: manifest.bodyOffsetInPayload,
      ...(fromLine ? { fromLine } : {}),
    });
    pages.push(page);
    fromLine = page.nextFromLine ?? undefined;
  } while (fromLine !== undefined && pages.length < 50);
  return pages;
}

describe('real result-door spill fixtures — calibration', () => {
  it.each(Object.keys(FIXTURE_FILES) as FixtureName[])(
    '%s is a byte-exact producer spill: its manifest SHA-256 verifies and one flipped byte is refused',
    (name) => {
      const { bytes, manifest, payload } = load(name);
      expect(manifest.schemaVersion).toBe('papercusp.scratch-reference/v1');
      expect(payload.length).toBe(manifest.byteCount);
      expect(payload.toString('utf8').startsWith('# result-door spill — ')).toBe(true);
      const tampered = Buffer.from(bytes);
      tampered[tampered.length - 1] ^= 0x01;
      let refusal: unknown;
      try {
        parseScratchReference(tampered);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ScratchReferenceError);
      expect((refusal as ScratchReferenceError).code).toBe('integrity_mismatch');
    },
  );

  it('covers the states the clauses need: a >=1 MB JSON body, a tool-truncated body and a text body with no final newline', () => {
    const large = load('large');
    expect(large.payload.length - large.manifest.bodyOffsetInPayload!).toBeGreaterThanOrEqual(1_000_000);
    expect(large.payload.toString('utf8')).toContain('no upstream truncation marker detected');
    expect(load('truncated').payload.toString('utf8')).toContain('the TOOL ITSELF already truncated field(s)');
    const text = load('text');
    expect(text.manifest.bodyOffsetInPayload).toBeUndefined();
    expect(text.payload.at(-1)).not.toBe(0x0a);
  });
});

describe('querySavedResult over real spills', () => {
  it('SPEC-P-005: returns every matching line of a real >=1 MB spill with its 1-based line number', () => {
    const oracle = oracleLines('large');
    const pages = allPages('large', 'P-001');
    const want = linesContaining(oracle, 'P-001');
    expect(want).toHaveLength(19);
    expect(pages[0].view).toBe('json-pretty');
    expect(pages[0].coverage.searchedLines).toBe(oracle.length);
    expect(pages[0].matchCount).toBe(want.length);
    expect(pages.flatMap((p) => p.matches.map((m) => m.line))).toEqual(want);
    for (const m of pages.flatMap((p) => p.matches)) expect(m.text.toLowerCase()).toContain('p-001');
    expect(pages.at(-1)!.coverage.scannedToEnd).toBe(true);
  });

  it('SPEC-P-005: context lines around each match are the neighbouring lines of the real body', () => {
    const oracle = oracleLines('truncated');
    const want = linesContaining(oracle, '"state"');
    expect(want.length).toBeGreaterThan(0);
    const pages = allPages('truncated', '"state"');
    const matches = pages.flatMap((p) => p.matches);
    expect(matches.map((m) => m.line)).toEqual(want);
    for (const m of matches) {
      const short = (l: string) => l.length <= QUERY_MAX_LINE_CHARS;
      const before = oracle.slice(Math.max(0, m.line - 1 - QUERY_DEFAULT_CONTEXT), m.line - 1);
      const after = oracle.slice(m.line, m.line + QUERY_DEFAULT_CONTEXT);
      if (before.every(short)) expect(m.before).toEqual(before);
      if (after.every(short)) expect(m.after).toEqual(after);
      if (short(oracle[m.line - 1])) expect(m.text).toBe(oracle[m.line - 1]);
    }
  });

  it('SPEC-P-005-NOMATCH: a query with no matching line reports complete coverage of a clean real body', () => {
    const { payload } = load('large');
    const [page] = allPages('large', 'zz-no-such-term-in-this-spill-zz');
    expect(page.matchCount).toBe(0);
    expect(page.matches).toEqual([]);
    expect(page.coverage).toMatchObject({
      payloadBytes: payload.length,
      searchedLines: oracleLines('large').length,
      fromLine: 1,
      scannedToEnd: true,
      upstreamPartialMarkers: 0,
    });
  });

  it('SPEC-P-005-NOMATCH: a query with no matching line reports the upstream truncation the tool recorded', () => {
    const { payload } = load('truncated');
    const [page] = allPages('truncated', 'zz-no-such-term-in-this-spill-zz');
    expect(page.matchCount).toBe(0);
    expect(page.coverage.payloadBytes).toBe(payload.length);
    expect(page.coverage.searchedLines).toBe(oracleLines('truncated').length);
    expect(page.coverage.scannedToEnd).toBe(true);
    expect(page.coverage.upstreamPartialMarkers).toBeGreaterThan(0);
  });

  it('SPEC-P-005-TAIL: finds a match on the final line of a real text spill that has no trailing newline', () => {
    const oracle = oracleLines('text');
    const last = oracle.length;
    expect(oracle[last - 1]).toContain('optional pre-check');
    expect(linesContaining(oracle, 'optional pre-check')).toEqual([last]);
    const [page] = allPages('text', 'optional pre-check');
    expect(page.view).toBe('text');
    expect(page.matches.map((m) => m.line)).toEqual([last]);
    expect(page.coverage.searchedLines).toBe(last);
    expect(page.coverage.scannedToEnd).toBe(true);
  });
});

describe('capability:read { file_path, query } over real spills (the tool surface)', () => {
  let sandbox: string;
  let prevScratchRoot: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'papercusp-read-query-real-'));
    prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
    mkdirSync(join(sandbox, 'scratch'), { recursive: true });
    doorConstantsMock.mockReset();
    doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
    else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** Place the verbatim fixture in the sandbox scratch root and pin the clock inside its validity window. */
  function place(name: FixtureName, at: 'valid' | 'expired' = 'valid'): string {
    const { manifest } = load(name);
    const filePath = join(sandbox, 'scratch', FIXTURE_FILES[name]);
    copyFileSync(join(FIXTURES, FIXTURE_FILES[name]), filePath);
    vi.setSystemTime(at === 'valid' ? Date.parse(manifest.createdAt) + 60_000 : Date.parse(manifest.expiresAt) + 1);
    return filePath;
  }

  async function query(
    filePath: string,
    args: Record<string, unknown>,
    caller: { workspaceId: string; ownerId: string },
  ) {
    const res = (await readTool.handler({ file_path: filePath, ...args } as never, {
      projectDir: sandbox,
      workspaceId: caller.workspaceId,
      isSuperuser: true,
      uiClientId: caller.ownerId,
    } as never)) as { content: Array<{ type: string; text: string }> };
    const text = res.content[0].text;
    return { text, parsed: JSON.parse(text) as Record<string, any> };
  }

  const owner = (name: FixtureName) => {
    const { manifest } = load(name);
    return { workspaceId: manifest.workspaceId, ownerId: manifest.ownerId! };
  };

  it('queries a large multi-line spill that its default line window refuses', async () => {
    const workspaceId = 'ws-query-large-text';
    const ownerId = '00000000-0000-4000-8000-000000000001';
    const payload = Array.from({ length: 160 }, (_, i) =>
      `entry-${i} needle-${i} ${'x'.repeat(48)}`,
    ).join('\n');
    const filePath = join(sandbox, 'scratch', 'large-text.scratch.md');
    writeScratchReference({
      filePath,
      payload,
      workspaceId,
      ownerId,
      audience: 'workspace',
      mediaType: 'text/plain',
      content: [{ index: 0, type: 'text', byteCount: Buffer.byteLength(payload) }],
    });
    const context = {
      projectDir: sandbox,
      workspaceId,
      isSuperuser: true,
      uiClientId: ownerId,
    } as never;

    const lineWindow = await readTool.handler({ file_path: filePath } as never, context) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(lineWindow.content[0].text)).toMatchObject({
      ok: false,
      reason: 'scratch_line_window_too_large',
    });

    const queryResult = await readTool.handler({
      file_path: filePath,
      query: 'needle-37',
      query_context: 0,
    } as never, context) as { content: Array<{ type: string; text: string }> };
    const queryText = queryResult.content[0].text;
    const parsed = JSON.parse(queryText) as Record<string, any>;
    expect(parsed).toMatchObject({
      ok: true,
      query: 'needle-37',
      matchCount: 1,
      coverage: { scannedToEnd: true },
    });
    expect(parsed.matches).toEqual([
      expect.objectContaining({ line: 38, text: expect.stringContaining('entry-37') }),
    ]);
    expect(Buffer.byteLength(queryText)).toBeLessThan(1_000);
  });

  /** Every page the tool returns for one query, following `next_cursor` as a caller would. */
  async function queryAllPages(name: FixtureName, term: string) {
    const filePath = place(name);
    const pages: Array<{ text: string; parsed: Record<string, any> }> = [];
    let fromLine: number | undefined;
    do {
      const page = await query(filePath, { query: term, ...(fromLine ? { query_from_line: fromLine } : {}) }, owner(name));
      expect(page.parsed.ok).toBe(true);
      pages.push(page);
      fromLine = page.parsed.next_cursor ? page.parsed.next_cursor.args.query_from_line : undefined;
    } while (fromLine !== undefined && pages.length < 50);
    return pages;
  }

  /** Matches exactly four lines of the large real spill (checked against the oracle below). */
  const FOUR_LINE_TERM = 'work-item:';

  it('AUTO-BAR-R-5-P-005: returns decoded matching lines with line numbers, context and coverage of a real spill', async () => {
    const { manifest } = load('large');
    const oracle = oracleLines('large');
    for (const term of [FOUR_LINE_TERM, 'P-001']) {
      const want = linesContaining(oracle, term);
      const pages = await queryAllPages('large', term);
      const first = pages[0].parsed;
      expect(first).toMatchObject({ view: 'json-pretty', matchCount: want.length });
      expect(pages.flatMap((p) => p.parsed.matches.map((m: { line: number }) => m.line))).toEqual(want);
      expect(first.matches[0].before).toHaveLength(QUERY_DEFAULT_CONTEXT);
      expect(first.matches[0].after).toHaveLength(QUERY_DEFAULT_CONTEXT);
      expect(first.coverage).toMatchObject({ payloadBytes: manifest.byteCount, searchedLines: oracle.length, upstreamPartialMarkers: 0 });
      expect(pages.at(-1)!.parsed.coverage.scannedToEnd).toBe(true);
      expect(first.reference).toMatchObject({ sha256: manifest.sha256, byteCount: manifest.byteCount });
    }
  });

  it('AUTO-BAR-R-5-P-005: reports an upstream-truncated body and finds a match at the end of a real body', async () => {
    const truncated = await query(place('truncated'), { query: 'zz-no-such-term-in-this-spill-zz' }, owner('truncated'));
    expect(truncated.parsed).toMatchObject({ ok: true, matchCount: 0 });
    expect(truncated.parsed.coverage.upstreamPartialMarkers).toBeGreaterThan(0);
    expect(truncated.parsed.note).toContain('upstream truncation marker');

    const oracle = oracleLines('text');
    const tail = await query(place('text'), { query: 'optional pre-check' }, owner('text'));
    expect(tail.parsed).toMatchObject({ ok: true, view: 'text', matchCount: 1 });
    expect(tail.parsed.matches[0].line).toBe(oracle.length);
    expect(tail.parsed.coverage.scannedToEnd).toBe(true);
  });

  /** A line of the text spill's body that the query below finds for its owner. */
  const BODY_LINE = 'umbState: wip';

  it('SPEC-P-005-REFUSED: CONTROL — the owner of the real spill finds the line', async () => {
    const { parsed, text } = await query(place('text'), { query: 'umbState' }, owner('text'));
    expect(parsed).toMatchObject({ ok: true, matchCount: 1 });
    expect(text).toContain(BODY_LINE);
  });

  it('SPEC-P-005-REFUSED: another owner in the same workspace is refused and receives no line of the body', async () => {
    const caller = { ...owner('text'), ownerId: 'su-not-the-creating-owner' };
    const { parsed, text } = await query(place('text'), { query: 'umbState' }, caller);
    expect(parsed).toMatchObject({ ok: false, reason: 'forbidden_reference' });
    expect(parsed).not.toHaveProperty('matches');
    expect(text).not.toContain(BODY_LINE);
    expect(text).not.toContain('UNVERIFIED OWNER ATTRIBUTION');
  });

  it('SPEC-P-005-REFUSED: another workspace is refused and receives no line of the body', async () => {
    const caller = { ...owner('text'), workspaceId: 'some-other-workspace' };
    const { parsed, text } = await query(place('text'), { query: 'umbState' }, caller);
    expect(parsed).toMatchObject({ ok: false, reason: 'workspace_mismatch' });
    expect(parsed).not.toHaveProperty('matches');
    expect(text).not.toContain(BODY_LINE);
  });

  it('SPEC-P-005-REFUSED: an expired real spill is refused and returns no line of the body', async () => {
    const { parsed, text } = await query(place('text', 'expired'), { query: 'umbState' }, owner('text'));
    expect(parsed).toMatchObject({ ok: false, reason: 'expired_reference' });
    expect(parsed).not.toHaveProperty('matches');
    expect(text).not.toContain(BODY_LINE);
  });

  it('AUTO-BAR-R-10-P-005: every page of a 4-match query over the real >=1 MB spill serializes to under 1% of its body', async () => {
    const { manifest, payload } = load('large');
    const bodyBytes = payload.length - manifest.bodyOffsetInPayload!;
    expect(bodyBytes).toBeGreaterThanOrEqual(1_000_000);
    const want = linesContaining(oracleLines('large'), FOUR_LINE_TERM);
    expect(want).toEqual([838, 881, 927, 970]);
    const pages = await queryAllPages('large', FOUR_LINE_TERM);
    expect(pages.flatMap((p) => p.parsed.matches.map((m: { line: number }) => m.line))).toEqual(want);
    // default context really was applied, so context bytes are part of what is measured
    expect(pages[0].parsed.matches[1].before).toHaveLength(QUERY_DEFAULT_CONTEXT);
    expect(pages[0].parsed.matches[1].after).toHaveLength(QUERY_DEFAULT_CONTEXT);
    // the cost is the whole serialized tool result of every page the caller reads
    const serialized = pages.reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0);
    expect(serialized).toBeGreaterThan(0);
    expect(serialized).toBeLessThan(bodyBytes / 100);
  });
});

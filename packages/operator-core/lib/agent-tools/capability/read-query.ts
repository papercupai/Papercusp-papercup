/**
 * Saved-result query for capability:read (token-efficiency-prompts-cache-and-behavior-2026-10-11
 * P-005 / R-5). Agents used to page a spilled result 4 KB of base64 at a time (measured
 * 2026-10-12: ~12.8k page reads/day, ~5 per spill), and every page is a full-context model
 * round trip. This searches the WHOLE retained body in one call and returns only the
 * matching lines (decoded text, line numbers, a little context) plus explicit coverage, so a
 * zero-hit answer says exactly what was searched instead of implying absence.
 *
 * Deterministic and in-memory by design (plan D-011): spills are short-lived files of usually a
 * few hundred KB, so a literal all-terms line scan needs no persistent index, embeddings or
 * ranking. Authorization/expiry are enforced by the caller BEFORE this runs — the same
 * authorizeScratchReference gate that guards every other read mode.
 *
 * Views: a one-line JSON body (the common MCP-result shape) is useless to a line search, so JSON
 * is pretty-printed, and MCP `content[].text` items that are themselves JSON are expanded in
 * place. Strings containing newlines are expanded into their own lines between `"""` fences
 * ({@link renderJsonView}). Line numbers therefore refer to the SEARCHED VIEW, which the result
 * names, and {@link readSavedResultLines} reads a range of that same view (search, then read the
 * lines around a hit: the grep → sed workflow a file gives).
 */

export const QUERY_DEFAULT_CONTEXT = 2;
export const QUERY_MAX_CONTEXT = 10;
export const QUERY_DEFAULT_MAX_MATCHES = 20;
export const QUERY_MAX_MATCHES = 100;
/** Keep a query result inside the ~6,000-char result door with room for the envelope. */
export const QUERY_OUTPUT_CHAR_BUDGET = 4_200;
export const QUERY_MAX_LINE_CHARS = 240;

export type SavedResultView = 'text' | 'json-pretty' | 'mcp-content';

export interface SavedResultQueryOptions {
  query: string;
  context?: number;
  maxMatches?: number;
  /** 1-based line of the searched view to resume from (paging past a budget cut). */
  fromLine?: number;
  /** Byte offset where a JSON body starts after a human-readable spill header. */
  bodyOffset?: number;
}

export interface SavedResultMatch {
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface SavedResultQueryResult {
  terms: string[];
  view: SavedResultView;
  matches: SavedResultMatch[];
  /** Every matching line in the searched range, including ones not returned. */
  matchCount: number;
  /** First line NOT yet examined/returned when the output budget or maxMatches stopped early. */
  nextFromLine: number | null;
  coverage: {
    payloadBytes: number;
    searchedLines: number;
    fromLine: number;
    /** True when every line from fromLine to the end was examined. */
    scannedToEnd: boolean;
    /** Count of tool-side truncation markers inside the saved body (`_partial`, `[TRUNCATED`, …). */
    upstreamPartialMarkers: number;
  };
}

const PARTIAL_MARKER = /"_partial"\s*:\s*true|"_truncated"\s*:\s*true|\[TRUNCATED\b|"truncated"\s*:\s*true/g;

/** Opens and closes a multi-line string expanded by {@link renderJsonView}. */
export const MULTILINE_FENCE = '"""';

/**
 * Pretty-print parsed JSON as view lines. The output is identical to `JSON.stringify(value, null, 1)`
 * except for strings that contain a newline (WI-6554700010008917). Those are written as their
 * decoded lines between `"""` fences, so a plan body, decision, checkpoint or memory reads and
 * searches like the text it is. Otherwise it is one escaped line clipped at QUERY_MAX_LINE_CHARS,
 * where context lines are unrelated neighbouring fields. Input comes from JSON.parse, so it holds
 * only null, booleans, numbers, strings, arrays and plain objects.
 */
export function renderJsonView(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number, prefix: string, suffix: string): void => {
    const pad = ' '.repeat(depth);
    if (typeof v === 'string' && v.includes('\n')) {
      out.push(`${pad}${prefix}${MULTILINE_FENCE}`);
      out.push(...v.split('\n'));
      out.push(`${pad}${MULTILINE_FENCE}${suffix}`);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(`${pad}${prefix}[]${suffix}`);
        return;
      }
      out.push(`${pad}${prefix}[`);
      v.forEach((item, i) => walk(item, depth + 1, '', i < v.length - 1 ? ',' : ''));
      out.push(`${pad}]${suffix}`);
      return;
    }
    if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 0) {
        out.push(`${pad}${prefix}{}${suffix}`);
        return;
      }
      out.push(`${pad}${prefix}{`);
      keys.forEach((k, i) =>
        walk((v as Record<string, unknown>)[k], depth + 1, `${JSON.stringify(k)}: `, i < keys.length - 1 ? ',' : ''),
      );
      out.push(`${pad}}${suffix}`);
      return;
    }
    out.push(`${pad}${prefix}${JSON.stringify(v)}${suffix}`);
  };
  walk(value, 0, '', '');
  return out;
}

/** Build the line-searchable view of a saved payload. Exported for tests. */
export function searchableView(payload: Buffer, bodyOffset?: number): { view: SavedResultView; lines: string[] } {
  const text = payload.toString('utf8');
  const hasOffset = bodyOffset !== undefined && Number.isSafeInteger(bodyOffset) && bodyOffset >= 0 && bodyOffset < payload.length;
  const header = hasOffset ? payload.subarray(0, bodyOffset).toString('utf8') : '';
  const body = hasOffset ? payload.subarray(bodyOffset).toString('utf8') : text;
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const content = (parsed as { content?: unknown } | null)?.content;
      const headerLines = header ? header.replace(/\n+$/, '').split('\n') : [];
      if (Array.isArray(content) && content.some((c) => c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string')) {
        const out: string[] = [...headerLines];
        content.forEach((item, i) => {
          const t = (item as { text?: unknown } | null)?.text;
          if (typeof t !== 'string') return;
          out.push(`── content[${i}] ──`);
          let rendered = t.split('\n');
          const tt = t.trimStart();
          if (tt.startsWith('{') || tt.startsWith('[')) {
            try { rendered = renderJsonView(JSON.parse(t)); } catch { /* keep raw text */ }
          }
          out.push(...rendered);
        });
        return { view: 'mcp-content', lines: out };
      }
      return { view: 'json-pretty', lines: [...headerLines, ...renderJsonView(parsed)] };
    } catch {
      /* not JSON — fall through to plain text */
    }
  }
  return { view: 'text', lines: text.split('\n') };
}

function clip(line: string, firstHit: number): string {
  if (line.length <= QUERY_MAX_LINE_CHARS) return line;
  const start = Math.max(0, Math.min(firstHit - Math.floor(QUERY_MAX_LINE_CHARS / 3), line.length - QUERY_MAX_LINE_CHARS));
  return `${start > 0 ? '…' : ''}${line.slice(start, start + QUERY_MAX_LINE_CHARS)}${start + QUERY_MAX_LINE_CHARS < line.length ? '…' : ''}`;
}

/** Search a saved payload for lines containing EVERY query term (case-insensitive, literal). */
export function querySavedResult(payload: Buffer, opts: SavedResultQueryOptions): SavedResultQueryResult {
  const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  const context = Math.min(QUERY_MAX_CONTEXT, Math.max(0, opts.context ?? QUERY_DEFAULT_CONTEXT));
  const maxMatches = Math.min(QUERY_MAX_MATCHES, Math.max(1, opts.maxMatches ?? QUERY_DEFAULT_MAX_MATCHES));
  const { view, lines } = searchableView(payload, opts.bodyOffset);
  const fromLine = Math.min(Math.max(1, opts.fromLine ?? 1), lines.length + 1);
  const upstreamPartialMarkers = (payload.toString('utf8').match(PARTIAL_MARKER) ?? []).length;

  const matches: SavedResultMatch[] = [];
  let matchCount = 0;
  let budget = QUERY_OUTPUT_CHAR_BUDGET;
  let nextFromLine: number | null = null;
  for (let i = fromLine - 1; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (terms.length === 0 || !terms.every((t) => lower.includes(t))) continue;
    matchCount++;
    if (nextFromLine !== null) continue; // keep counting so the total stays honest
    const firstHit = Math.min(...terms.map((t) => lower.indexOf(t)));
    const m: SavedResultMatch = {
      line: i + 1,
      text: clip(lines[i], firstHit),
      before: lines.slice(Math.max(0, i - context), i).map((l) => clip(l, 0)),
      after: lines.slice(i + 1, i + 1 + context).map((l) => clip(l, 0)),
    };
    const cost = m.text.length + m.before.join('').length + m.after.join('').length + 40;
    if (matches.length >= maxMatches || (matches.length > 0 && cost > budget)) {
      nextFromLine = i + 1;
      continue;
    }
    budget -= cost;
    matches.push(m);
  }
  return {
    terms,
    view,
    matches,
    matchCount,
    nextFromLine,
    coverage: {
      payloadBytes: payload.length,
      searchedLines: lines.length,
      fromLine,
      scannedToEnd: true,
      upstreamPartialMarkers,
    },
  };
}

export const VIEW_DEFAULT_LIMIT = 60;
export const VIEW_MAX_LIMIT = 400;
/** A line longer than this is clipped in a range read; the clip says how much was cut. */
export const VIEW_MAX_LINE_CHARS = 1_000;

export interface SavedResultLinesOptions {
  /** 1-based first line of the searched view. */
  offset: number;
  limit?: number;
  bodyOffset?: number;
}

export type SavedResultLinesResult =
  | {
      ok: true;
      view: SavedResultView;
      totalLines: number;
      startLine: number;
      endLine: number;
      /** `<line>\t<text>` rows, the same coordinates a query's match.line uses. */
      lines: string[];
      /** First line not returned because the limit or the output budget stopped the read. */
      nextOffset: number | null;
      clippedLines: number;
    }
  | { ok: false; view: SavedResultView; totalLines: number; reason: 'view_window_out_of_range'; message: string };

/**
 * Read lines `offset..offset+limit-1` of the SAME view a saved-result query searches
 * (WI-6554700010008917), so a hit at line N can be read in context. Raw offset/limit address the
 * spill FILE's physical lines instead, which for a one-line JSON body are a different, much shorter
 * coordinate space. An offset past the end is refused, never answered with an empty window.
 */
export function readSavedResultLines(payload: Buffer, opts: SavedResultLinesOptions): SavedResultLinesResult {
  const { view, lines } = searchableView(payload, opts.bodyOffset);
  const totalLines = lines.length;
  if (opts.offset > totalLines) {
    return {
      ok: false,
      view,
      totalLines,
      reason: 'view_window_out_of_range',
      message: `The searched ${view} view has ${totalLines} lines; view_lines.offset ${opts.offset} is past the end.`,
    };
  }
  const limit = Math.min(VIEW_MAX_LIMIT, Math.max(1, opts.limit ?? VIEW_DEFAULT_LIMIT));
  const start = Math.max(1, opts.offset);
  const last = Math.min(totalLines, start + limit - 1);
  const out: string[] = [];
  let budget = QUERY_OUTPUT_CHAR_BUDGET;
  let clippedLines = 0;
  let nextOffset: number | null = last < totalLines ? last + 1 : null;
  for (let n = start; n <= last; n++) {
    let text = lines[n - 1];
    if (text.length > VIEW_MAX_LINE_CHARS) {
      text = `${text.slice(0, VIEW_MAX_LINE_CHARS)}… [+${text.length - VIEW_MAX_LINE_CHARS} chars]`;
      clippedLines++;
    }
    const row = `${n}\t${text}`;
    if (out.length > 0 && row.length + 1 > budget) {
      nextOffset = n;
      break;
    }
    budget -= row.length + 1;
    out.push(row);
  }
  return {
    ok: true,
    view,
    totalLines,
    startLine: start,
    endLine: start + out.length - 1,
    lines: out,
    nextOffset,
    clippedLines,
  };
}

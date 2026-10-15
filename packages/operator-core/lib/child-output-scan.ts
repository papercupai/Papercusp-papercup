/**
 * Finds chunk-boundary-unsafe text accumulation inside stream `data` handlers.
 *
 * Shared by the guard test (child-output-guard.test.ts). Lives in its own module
 * so the scanner itself is unit-testable against fixtures — a guard whose
 * DETECTOR is untested can go quietly blind and its green then means nothing,
 * which is the exact failure the guard exists to prevent.
 *
 * See child-output.ts for the bug being detected (WI-6728).
 */

/** One chunk-unsafe accumulation site. */
export interface ChunkUnsafeSite {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line of the accumulation itself, not of the handler. */
  line: number;
  /** The offending source line, trimmed. */
  text: string;
  /** Enclosing top-level symbol (`const foo = …`, `function foo`, …), if resolvable. */
  symbol: string | null;
}

/**
 * Accumulation of a per-chunk decode:
 *   acc += String(d)
 *   acc += d.toString()      /  d.toString('utf8')  /  d?.toString()
 *   acc += `${d}`
 * Deliberately NOT matched: `chunks.push(d)` (byte-exact, correct) and
 * `acc += 'a literal'` (not a chunk).
 */
const ACCUMULATE = /\+=\s*(?:String\(|`\$\{|[A-Za-z_$][\w$]*\??\.toString\(\s*(?:(?:'utf8'|"utf8"|'utf-8'|"utf-8")\s*)?\))/i;

/** The same lossy decode hidden in a bounded reassignment, e.g. `s = (s + String(d)).slice(-n)`. */
const ASSIGN_ACCUMULATE =
  /([A-Za-z_$][\w$]*)\s*=\s*\(?\s*\1\s*\+\s*(?:String\(|`\$\{|[A-Za-z_$][\w$]*\??\.toString\(\s*(?:(?:'utf8'|"utf8"|'utf-8'|"utf-8")\s*)?\))/i;

const accumulatesDecodedChunk = (line: string): boolean =>
  ACCUMULATE.test(line) || ASSIGN_ACCUMULATE.test(line);

const escapeIdentifier = (value: string): string => value.replace(/\$/g, '\\$');

/** A text concat can hide the decode behind a differently-named temporary. */
const combinesDecodedChunk = (line: string, parameter: string | null): boolean => {
  if (parameter === null) return false;
  const escaped = escapeIdentifier(parameter);
  const decoded =
    `(?:String\\(\\s*${escaped}\\s*\\)|${escaped}\\??\\.toString\\(\\s*(?:(?:'utf8'|"utf8"|'utf-8'|"utf-8")\\s*)?\\))`;
  return new RegExp(`\\+\\s*${decoded}`).test(line);
};

/** Find `const text = chunk.toString()` so a later `output += text` is visible. */
const decodedAlias = (line: string, parameter: string | null): string | null => {
  if (parameter === null) return null;
  const escaped = escapeIdentifier(parameter);
  const decoded =
    `(?:String\\(\\s*${escaped}\\s*\\)|${escaped}\\??\\.toString\\(\\s*(?:(?:'utf8'|"utf8"|'utf-8'|"utf-8")\\s*)?\\)|\\x60\\$\\{\\s*${escaped}\\s*\\}\\x60)`;
  return new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${decoded}`).exec(line)?.[1] ?? null;
};

const accumulatesAlias = (line: string, alias: string): boolean => {
  const escaped = escapeIdentifier(alias);
  return (
    new RegExp(`\\+=\\s*${escaped}(?![\\w$.])`).test(line) ||
    new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*\\(?\\s*\\1\\s*\\+\\s*${escaped}(?![\\w$.])`).test(line)
  );
};

/** A bare string accumulation of the handler's chunk parameter is unsafe too. */
const accumulatesChunkParameter = (line: string, parameter: string | null): boolean =>
  parameter !== null && new RegExp(`\\+=\\s*${parameter}(?![\\w$.])`).test(line);

/** Opens a `data` subscription: `.on('data',` / `.addListener("data",` */
const DATA_HANDLER = /\.(?:on|addListener|once)\(\s*['"]data['"]\s*,/;

/** A `.on('data', append)` / `.addListener('data', append)` reference. */
const namedDataCallback = (line: string): string | null =>
  /\.(?:on|addListener|once)\(\s*['"]data['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(line)?.[1] ?? null;

function findNamedCallback(lines: string[], name: string): { start: number; end: number; parameter: string } | null {
  const escaped = escapeIdentifier(name);
  const declarations = [
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(\\s*([A-Za-z_$][\\w$]*)(?:\\s*:[^,)=]+)?\\s*\\)\\s*=>\\s*\\{`),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?([A-Za-z_$][\\w$]*)\\s*=>\\s*\\{`),
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(\\s*([A-Za-z_$][\\w$]*)(?:\\s*:[^,)=]+)?\\s*\\)\\s*\\{`),
  ];
  for (let i = 0; i < lines.length; i++) {
    const match = declarations.map((pattern) => pattern.exec(lines[i])).find(Boolean);
    if (!match) continue;
    const parameter = match[1];
    const open = lines[i].indexOf('{', match.index);
    if (open < 0) continue;
    let depth = 0;
    for (let j = i; j < Math.min(i + 40, lines.length); j++) {
      const line = lines[j];
      for (let k = j === i ? open : 0; k < line.length; k++) {
        if (line[k] === '{') depth++;
        else if (line[k] === '}') {
          depth--;
          if (depth === 0) return { start: i, end: j, parameter };
        }
      }
    }
  }
  return null;
}

/**
 * Resolve a line to its enclosing TOP-LEVEL symbol.
 *
 * Indentation-zero declarations only. A naive nearest-declaration walk finds
 * the local `const child = spawn(...)` on the matching line itself, so every
 * site resolves to a symbol named `child` and any symbol-keyed allowlist
 * silently matches nothing — a guard that passes while checking nothing.
 */
export function enclosingTopLevelSymbol(lines: string[], lineIdx: number): string | null {
  const decl =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
  for (let i = lineIdx; i >= 0; i--) {
    const m = decl.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * Scan one file's source for chunk-unsafe accumulation sites.
 *
 * Walks the `data` handler's real extent by paren depth rather than by a fixed
 * line window, so an accumulation in a SIBLING handler (`child.on('error', e =>
 * { stderr += String(e) })` — an Error, not a chunk, and correct) is not
 * mistaken for one inside the data handler.
 */
export function scanSource(
  file: string,
  src: string,
  // Direct parameter accumulation is opt-in for known Buffer-backed streams;
  // streams with setEncoding() legitimately emit strings.
  options: { includeBareChunkParameter?: boolean } = {},
): ChunkUnsafeSite[] {
  const lines = src.split('\n');
  const hits: ChunkUnsafeSite[] = [];
  const seen = new Set<number>();

  const scanRegion = (start: number, end: number, chunkParameter: string | null): void => {
    const aliases = new Map<string, number>();
    const reportedAliases = new Set<string>();
    for (let j = start; j <= end; j++) {
      const line = lines[j];
      const alias = decodedAlias(line, chunkParameter);
      if (alias && !aliases.has(alias)) aliases.set(alias, j);
      const unsafe =
        accumulatesDecodedChunk(line) ||
        combinesDecodedChunk(line, chunkParameter) ||
        (options.includeBareChunkParameter === true && accumulatesChunkParameter(line, chunkParameter));
      if (unsafe && !seen.has(j)) {
        seen.add(j);
        hits.push({ file, line: j + 1, text: line.trim(), symbol: enclosingTopLevelSymbol(lines, j) });
      }
      for (const [name, aliasLine] of aliases) {
        if (reportedAliases.has(name) || !accumulatesAlias(line, name) || seen.has(aliasLine)) continue;
        seen.add(aliasLine);
        reportedAliases.add(name);
        hits.push({ file, line: aliasLine + 1, text: lines[aliasLine].trim(), symbol: enclosingTopLevelSymbol(lines, aliasLine) });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const open = DATA_HANDLER.exec(lines[i]);
    if (open === null) continue;
    const named = namedDataCallback(lines[i]);
    if (named) {
      const callback = findNamedCallback(lines, named);
      if (callback) scanRegion(callback.start, callback.end, callback.parameter);
      continue;
    }
    const callback =
      /,\s*(?:async\s*)?(?:\(\s*([A-Za-z_$][\w$]*)\b|([A-Za-z_$][\w$]*)\s*=>|function\s*\(\s*([A-Za-z_$][\w$]*))/.exec(
        lines[i],
      );
    const chunkParameter = callback?.[1] ?? callback?.[2] ?? callback?.[3] ?? null;

    // Walk from `.on(` to its matching close paren, tracking paren depth.
    //
    // ⚠ The accumulation must be tested against the depth AT THE START of the
    // line, not after the whole line is accounted for. The dominant form is a
    // ONE-LINE arrow — `.on('data', (d) => (s += String(d)))` — which opens and
    // closes the handler on the same line, so an end-of-line depth check reads
    // 0 and skips it. That mistake made this scanner miss ~84% of real sites.
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < Math.min(i + 40, lines.length); j++) {
      const line = lines[j];
      for (let k = j === i ? open.index : 0; k < line.length; k++) {
        if (line[k] === '(') {
          depth++;
          started = true;
        } else if (line[k] === ')') {
          depth--;
        }
      }
      end = j;
      if (started && depth <= 0) break;
    }
    scanRegion(i, end, chunkParameter);
  }
  return hits;
}

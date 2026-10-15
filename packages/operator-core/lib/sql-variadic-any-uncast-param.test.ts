/**
 * WI-10002085 — CLASS guard: no uncast parameter may sit as a bare argument of a
 * VARIADIC "any" SQL function.
 *
 * The defect. `jsonb_build_object` / `jsonb_build_array` (and their `json_` siblings) are
 * declared VARIADIC "any", so an argument supplies NO type for the planner to resolve a
 * parameter against. Postgres therefore rejects the statement at PARSE time:
 *
 *     ERROR: could not determine data type of parameter $N
 *
 * PARSE time is what makes this severe out of proportion to its size: the statement fails on
 * EVERY call, before a single row is examined, so the feature is 100% dead rather than flaky.
 * postgres.js sends type OID 0 for a JS string, number, null or plain object (see `inferType`
 * in postgres/src/types.js); only boolean (16), bigint (20), Date (1184) and a Parameter from
 * `sql.json()` carry their own OID. So a bare `${x}` in one of these argument lists is a
 * production outage in waiting unless it is one of those four shapes.
 *
 * Why a CLASS guard and not another per-statement test. This has now shipped three times:
 *   1. WI-37757  validate-active-routines.ts   — routines never auto-deactivated; the throw was
 *                caught and logged, rows stayed active, re-logging FATAL on every worker boot.
 *   2. work-items.ts refreshPlanLinkedFeatureWorkItem — threw on every call; text-drift-report's
 *                `catch {}` swallowed it silently, so plan-item drift never refreshed the
 *                linked work-item.
 *   3. WI-10002085 goal-liveness-watchdog.ts pauseGoalForHolderRespawnRateCap — the holder
 *                respawn safety cap could NEVER pause a goal; a goal marked needsHuman kept
 *                running for ~50min with the rail believing it had stopped it.
 *
 * Each was fixed with a test for THAT statement, and each time the class walked to a new file.
 * The common enabler is structural: every one of those statements *was* covered by a test that
 * mocked `sql`, and a mock asserts the statement was BUILT correctly — it cannot observe a
 * server-side PARSE failure by construction. A static class guard is the only cheap check that
 * does not depend on someone remembering to exercise the statement against a real server.
 *
 * The baseline is EMPTY and must stay empty. A new finding is a bug, not a budget to raise.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** This file's own repo-relative path — excluded from the repo scan (see the fixture note). */
const SELF = 'packages/operator-core/lib/sql-variadic-any-uncast-param.test.ts';

/**
 * Files that contain the broken shape ON PURPOSE, as a negative control proving their own
 * guard can fail. Each entry must still exist, so a stale exemption fails instead of rotting.
 */
const DELIBERATE_CONTROLS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'packages/operator-core/lib/startup/validate-active-routines-sql.integration.test.ts',
    why: 'WI-37757 reproduces the uncast statement inline as the negative control for its own guard.',
  },
  {
    file: 'packages/operator-core/lib/system-health/goal-holder-respawn.integration.test.ts',
    why: 'WI-10002085 reproduces the uncast statement inline as the negative control for its own guard.',
  },
];

const VARIADIC_ANY_FNS = ['jsonb_build_object', 'jsonb_build_array', 'json_build_object', 'json_build_array'];

export type UncastFinding = { file: string; line: number; fn: string; arg: string };

/** Split an argument list on commas at depth 0 so nested calls stay intact. */
function splitTopLevelArgs(argText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of argText) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * A substitution whose VALUE carries its own type OID, so Postgres never has to infer it.
 * Kept deliberately syntactic and narrow: anything we cannot see the type of must be cast.
 */
function carriesItsOwnTypeOid(arg: string): boolean {
  const inner = arg.replace(/^\$\{/, '').replace(/\}$/, '').trim();
  return (
    /^(true|false)$/.test(inner) || // boolean -> OID 16
    /^Boolean\s*\(/.test(inner) ||
    /^BigInt\s*\(/.test(inner) || // bigint -> OID 20
    /^\d+n$/.test(inner) ||
    /^new\s+Date\s*\(/.test(inner) || // Date -> OID 1184
    /\bsql\.json\s*\(/.test(inner) // Parameter carries its declared type
  );
}

/**
 * Identifiers bound to a nested `sql` fragment in this file.
 *
 * `jsonb_build_object('plan_item', ${sourceStamp})` LOOKS like a bare parameter but is not one:
 * postgres.js inlines a nested tagged template as SQL text and hoists its own parameters into
 * the outer statement, so there is no parameter for the planner to type. (Verified directly
 * against Postgres: the composition succeeds once the fragment's OWN params are cast, and a
 * failure inside it reports the INNER parameter's number.) Skipping these keeps the baseline at
 * zero by being right, rather than by exempting a call site that was never broken.
 *
 * Heuristic and deliberately conservative: only a binding whose initializer text contains a
 * `sql` template counts. An identifier we cannot resolve is still flagged — the guard's failure
 * direction is toward asking for a cast that was not strictly needed, never toward silence.
 */
function sqlFragmentIdentifiers(source: string): Set<string> {
  const ids = new Set<string>();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=(.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    const [, indentText = '', name = '', rest = ''] = m;
    const indent = indentText.length;
    let initializer = rest;
    // An initializer CONTINUES only while the lines below it are indented deeper than the
    // binding itself (the real multi-line shape is `const x =\n  cond\n    ? sql`…``). A simple
    // "read until the next semicolon" span silently ran past the end of a semicolon-less
    // binding and swallowed the NEXT statement, which whitelisted an identifier that was never
    // a fragment — i.e. it disarmed the guard. Its control test is what caught that.
    for (let j = i + 1; j < lines.length && !initializer.includes(';'); j++) {
      const line = lines[j] ?? '';
      if (line.trim() === '') continue;
      if (line.length - line.trimStart().length <= indent) break;
      initializer += `\n${line}`;
    }
    if (/\bsql\s*(?:<[^>]*>)?\s*`/.test(initializer.split(';')[0] ?? '')) ids.add(name);
  }
  return ids;
}

/**
 * Literal text in an untagged template is JS string interpolation, never parameter binding.
 *
 * `sql.unsafe(\`SELECT jsonb_build_object(${keyObject}) …\`, [limit])` LOOKS like the broken
 * shape but contains no parameter at all: the template is UNTAGGED, so `${keyObject}` is ordinary
 * JS string interpolation of SQL TEXT, and the only bound parameters are the `$N` placeholders
 * in the params array. (Found at libs/generic/search/src/chunks/embed.ts, where the text is a
 * list of identifiers validated by `validateChunkEmbedTarget`.) Skipping it is being right about
 * the semantics, like the fragment rule above, not exempting a call site that was ever broken.
 *
 * This also holds when the text is assigned to a variable before reaching `.unsafe`, as in
 * the R-11 query builder. Use parsed literal spans so a tagged SQL template nested INSIDE a
 * plain template's expression still scans. Unknown tags remain conservative candidates.
 */
function plainTemplateTextSpans(source: string, file: string): Array<[number, number]> {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const spans: Array<[number, number]> = [];
  const visit = (node: ts.Node) => {
    if (!ts.isTaggedTemplateExpression(node.parent)) {
      if (ts.isNoSubstitutionTemplateLiteral(node)) spans.push([node.getStart(parsed), node.end]);
      else if (ts.isTemplateExpression(node)) {
        spans.push([node.head.getStart(parsed), node.head.end]);
        for (const span of node.templateSpans) spans.push([span.literal.getStart(parsed), span.literal.end]);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return spans;
}

export function findUncastVariadicAnyParams(source: string, file: string): UncastFinding[] {
  const findings: UncastFinding[] = [];
  const fragments = sqlFragmentIdentifiers(source);
  const plainText = plainTemplateTextSpans(source, file);
  for (const fn of VARIADIC_ANY_FNS) {
    let cursor = 0;
    for (;;) {
      const at = source.indexOf(`${fn}(`, cursor);
      if (at === -1) break;
      cursor = at + fn.length;
      if (plainText.some(([start, end]) => start <= at && at < end)) continue;
      let depth = 0;
      let end = at + fn.length;
      for (; end < source.length; end++) {
        const ch = source[end];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) break; // unbalanced (or truncated source) — stop scanning this function
      const args = splitTopLevelArgs(source.slice(at + fn.length + 1, end));
      for (const raw of args) {
        const arg = raw.trim();
        // The ONLY failing shape: the entire argument is one substitution, with no cast after it.
        if (!/^\$\{[\s\S]*\}$/.test(arg)) continue;
        if (/\}\s*::/.test(arg)) continue; // cast supplies the type
        if (carriesItsOwnTypeOid(arg)) continue;
        if (fragments.has(arg.slice(2, -1).trim())) continue; // nested fragment, not a parameter
        findings.push({
          file,
          line: source.slice(0, at).split('\n').length,
          fn,
          arg: arg.replace(/\s+/g, ' ').slice(0, 100),
        });
      }
    }
  }
  return findings;
}

/**
 * Fixtures live in string literals INSIDE this file, and the repo scan below reads files from
 * disk — so without excluding SELF this guard would flag its own fixtures and be red forever.
 * A guard that is permanently red gets weakened by whoever next touches it, so the exclusion is
 * deliberate. The detector-shape assertions in the first describe() are what keep the exclusion
 * honest: if a later edit makes a fixture unmatchable, those fail rather than passing vacuously.
 */
const BROKEN_FIXTURE = "sql`SELECT jsonb_build_object('attemptsInWindow', ${attemptsInWindow})`";
const CAST_FIXTURE = "sql`SELECT jsonb_build_object('attemptsInWindow', ${attemptsInWindow}::int)`";
const BOOLEAN_FIXTURE = "sql`SELECT jsonb_build_object('rig', ${Boolean(f.needs_rig)})`";
const JSON_PARAM_FIXTURE = "sql`SELECT jsonb_build_object('gen', ${sql.json({ ...record })})`";
const NESTED_FIXTURE = "sql`SELECT jsonb_build_object('at', to_jsonb(to_timestamp(${nowMs} / 1000.0)))`";
const FRAGMENT_FIXTURE = [
  "const sourceStamp = sql`jsonb_build_object('plan_slug', ${planSlug}::text)`",
  "const stamped = sql`SELECT jsonb_build_object('plan_item', ${sourceStamp})`",
].join('\n');
const UNSAFE_TEXT_FIXTURE =
  'const rows = await sql.unsafe<{ key: Record<string, unknown>; text: string }[]>(\n' +
  '  `SELECT jsonb_build_object(${keyObject}) AS key FROM t LIMIT $1`,\n' +
  '  [limit] as never[],\n' +
  ');';

describe('the detector itself is falsifiable', () => {
  it('flags a bare uncast parameter (the shape all three incidents shipped)', () => {
    const found = findUncastVariadicAnyParams(BROKEN_FIXTURE, 'fixture.ts');
    expect(found).toHaveLength(1);
    expect(found[0]?.arg).toContain('attemptsInWindow');
  });

  it('the broken fixture is still detector-SHAPED, so the control cannot pass vacuously', () => {
    // Without this, a later "tidy-up" of the fixture string would silently disarm the test above.
    expect(BROKEN_FIXTURE).toMatch(/jsonb_build_object\([^)]*\$\{/);
    expect(BROKEN_FIXTURE).not.toMatch(/\}\s*::/);
  });

  it.each([
    ['an explicit cast', CAST_FIXTURE],
    ['a boolean (OID 16 is sent)', BOOLEAN_FIXTURE],
    ['a sql.json Parameter (carries its own type)', JSON_PARAM_FIXTURE],
    ['a parameter inside a typed expression', NESTED_FIXTURE],
  ])('does NOT flag %s', (_label, fixture) => {
    expect(findUncastVariadicAnyParams(fixture, 'fixture.ts')).toEqual([]);
  });

  it('does NOT flag a nested sql fragment — postgres.js inlines it, so it is never a parameter', () => {
    expect(findUncastVariadicAnyParams(FRAGMENT_FIXTURE, 'fixture.ts')).toEqual([]);
  });

  it('STILL flags a bare identifier that is NOT bound to a fragment', () => {
    // The fragment rule must stay a narrow exception, not a blanket amnesty for any identifier:
    // that would silently disarm the guard for the exact shape all three incidents shipped.
    const notAFragment = [
      'const stamp = buildStamp()',
      "sql`SELECT jsonb_build_object('plan_item', ${stamp})`",
    ].join('\n');
    expect(findUncastVariadicAnyParams(notAFragment, 'fixture.ts')).toHaveLength(1);
  });

  it('does NOT flag text interpolation in a plain template passed to sql.unsafe(...)', () => {
    expect(findUncastVariadicAnyParams(UNSAFE_TEXT_FIXTURE, 'fixture.ts')).toEqual([]);
  });

  it('the unsafe exemption is about the TAG: the same body as a tagged sql template IS flagged', () => {
    // Calibration: without this, the case above could pass because the fixture stopped being
    // detector-shaped rather than because the untagged-template rule recognised it.
    expect(UNSAFE_TEXT_FIXTURE).toMatch(/jsonb_build_object\(\$\{keyObject\}\)/);
    const tagged = 'sql`SELECT jsonb_build_object(${keyObject}) AS key FROM t`';
    expect(findUncastVariadicAnyParams(tagged, 'fixture.ts')).toHaveLength(1);
  });

  it('the unsafe exemption does not leak past the unsafe template into a later tagged template', () => {
    const later = [
      'await sql.unsafe(`SELECT 1`, []);',
      "const r = sql`SELECT jsonb_build_object('a', ${v})`;",
    ].join('\n');
    expect(findUncastVariadicAnyParams(later, 'fixture.ts')).toHaveLength(1);
  });

  it('recognises assigned SQL text while the same text tagged as SQL remains unsafe', () => {
    const plain = "const key = `jsonb_build_array(${target.keyCols.join(', ')})::text`;";
    expect(findUncastVariadicAnyParams(plain, 'fixture.ts')).toEqual([]);
    expect(findUncastVariadicAnyParams(plain.replace('= `', '= sql`'), 'fixture.ts')).toHaveLength(1);
  });

  it('still scans tagged SQL nested inside a plain template expression', () => {
    const nested = 'const text = `key: ${sql`jsonb_build_array(${value})`}`;';
    expect(findUncastVariadicAnyParams(nested, 'fixture.ts')).toHaveLength(1);
  });

  it('does not treat an unknown template tag as plain string interpolation', () => {
    expect(findUncastVariadicAnyParams('query`jsonb_build_array(${value})`', 'fixture.ts'))
      .toHaveLength(1);
  });

  it('finds a parameter in a NESTED variadic-any call, not just the outer one', () => {
    const nested = "sql`SELECT jsonb_build_object('a', 1, 'b', jsonb_build_object('c', ${v}))`";
    expect(findUncastVariadicAnyParams(nested, 'fixture.ts')).toHaveLength(1);
  });
});

describe('no uncast parameter reaches a VARIADIC "any" argument anywhere in the tree', () => {
  it('every deliberate-control exemption still exists', () => {
    for (const entry of DELIBERATE_CONTROLS) {
      expect(existsSync(path.join(REPO_ROOT, entry.file)), `stale exemption: ${entry.file}`).toBe(true);
    }
  });

  it('the repo baseline is empty', () => {
    let listed = '';
    try {
      listed = execFileSync(
        'git',
        ['grep', '-l', '--recurse-submodules', '-E', String.raw`jsonb?_build_(object|array)`, '--', '*.ts'],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      // git grep exits 1 for "no matches". That is indistinguishable from a broken invocation,
      // and an empty haystack would make this assertion pass without measuring anything — so
      // treat it as a failure of the instrument rather than a clean bill of health.
      const status = (error as { status?: number }).status;
      throw new Error(
        `git grep found no candidate files (status=${status}). This guard measures nothing in ` +
          `that state; fix the scan rather than accepting the empty result.`,
      );
    }

    const files = listed.split('\n').filter(Boolean);
    const exempt = new Set([SELF, ...DELIBERATE_CONTROLS.map((entry) => entry.file)]);
    const scanned = files.filter((file) => !exempt.has(file) && !file.includes('node_modules'));

    // Positive control on the POPULATION, not just the detector: if the scan silently stops
    // finding files, an empty findings list below would look like success.
    expect(scanned.length).toBeGreaterThan(20);

    const findings = scanned.flatMap((file) => {
      const abs = path.join(REPO_ROOT, file);
      if (!existsSync(abs)) return []; // submodule path listed but not checked out
      return findUncastVariadicAnyParams(readFileSync(abs, 'utf8'), file);
    });

    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.fn}(… ${f.arg} …)`),
      'An uncast parameter inside a VARIADIC "any" SQL function fails at PARSE time on EVERY ' +
        'call — "could not determine data type of parameter $N". Add a cast (${x}::int, ' +
        '${x}::text, ${x}::bigint) or pass sql.json(x). Do NOT exempt it here: this has already ' +
        'shipped three times (WI-37757, work-items.ts, WI-10002085).',
    ).toEqual([]);
  });
});

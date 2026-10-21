/**
 * sql-text-alias-order-guard.test.ts — WI-10004608's recurrence guard.
 *
 * In Postgres a BARE name in a query's top-level ORDER BY binds to an OUTPUT column first.
 * So `SELECT id::text AS id ... ORDER BY id` sorts the TEXT alias, not the bigint column:
 * '10' < '1000' < '8' < '999'. Nothing errors; the rows simply come back in the wrong order,
 * and only once ids cross a digit-length boundary, so a test whose ids share one length
 * cannot see it. Instances, each found and fixed one at a time before this guard:
 *
 *   activity:recent (agent-tools/activity/recent.ts)  froze at id 999 once the sequence hit 1000
 *   usage repricer (WI-10004517)                      reported complete with 934,532 of 1,272,436 rows untouched
 *   activity stream drain (WI-10004608)               page-max cursor skipped 8, 9, 998, 999 in its test
 *   intent re-hydration (WI-10004608)                 returned an owner's older intent ('999' > '1000')
 *
 * ─── WHAT IS FLAGGED ─────────────────────────────────────────────────────────
 * A SQL literal (template or string) where, inside ONE parenthesis scope, an
 * integer-shaped expression is cast to text under an alias (`x::text AS a`, or
 * `CAST(x AS text) AS a`) and that scope's ORDER BY sorts by the bare alias `a`.
 * Integer-shaped = a column named `id`, `*_id`, `seq` or `*_seq`, or a count/sum/length/
 * row_number/rank call. Window and aggregate ORDER BYs (`OVER (ORDER BY id)`,
 * `array_agg(x ORDER BY id)`) live in their own parenthesis scope, which has no alias,
 * and they bind to input columns anyway, so they are correctly ignored.
 *
 * TIMESTAMPS too (WI-10004628). timestamptz text carries the session's UTC offset, and the
 * server default zone here is America/New_York, so across a DST fall-back hour a LATER
 * instant ('01:10-05') sorts before an EARLIER one ('01:30-04'). Measured on the live server
 * under that zone: ORDER BY the alias returned 06:10Z before 05:30Z; ORDER BY the column did
 * not. Timestamp-shaped = a column named `at`, `ts`, `*_at` or `*_ts`, a now()-family call,
 * or any other call whose alias has one of those names (`COALESCE(ts, x)::text AS ts`).
 * A set operation's outer ORDER BY (`(SELECT ...) UNION ALL (SELECT ...) ORDER BY ts`) sorts
 * by its first branch's output names, so it is checked against that branch's aliases.
 *
 * ⚠ Bounds (not detected): a positional `ORDER BY 1`; an outer query ordering by a text
 * column of a derived table (`FROM (SELECT id::text AS id ...) s ORDER BY id`). A `*_id`
 * (or bare `id`) column that is a uuid is flagged and exempted below, because uuid text
 * order equals uuid order.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { listTrackedFiles } from '../../../scripts/lib/tracked-files.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCAN_PREFIXES = ['packages/', 'apps/', 'libs/', 'scripts/'];
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const NOT_SOURCE = /\.(test|spec)\.tsx?$|\/__tests__\/|\.d\.ts$|\/dist\/|\/node_modules\//;

const TEXT_TYPE = String.raw`(?:text|varchar|character\s+varying|citext)`;
const CAST_CALL = new RegExp(String.raw`\bCAST\s*\(\s*([^()]*?)\s+AS\s+${TEXT_TYPE}\s*\)`, 'gi');
/** `<source>::text AS <alias>` once inner parentheses are flattened to `()`. */
const TEXT_ALIAS = new RegExp(String.raw`([A-Za-z_][\w.]*(?:\(\))?)\s*::\s*${TEXT_TYPE}\s+AS\s+"?([A-Za-z_]\w*)"?`, 'gi');
const INTEGER_COLUMN = /^(?:id|\w+_id|seq|\w+_seq)$/i;
const INTEGER_CALL = /^(?:count|sum|length|char_length|row_number|rank|dense_rank)\(\)$/i;
const ORDER_BY = /\bORDER\s+BY\s+/gi;
const CLAUSE_END = /\b(?:LIMIT|OFFSET|FETCH|FOR\s+(?:UPDATE|SHARE|NO\s+KEY|KEY)|UNION|INTERSECT|EXCEPT|WINDOW)\b|;/i;

const TIMESTAMP_COLUMN = /^(?:at|ts|\w+_at|\w+_ts)$/i;
const TIMESTAMP_CALL = /^(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\(\)$/i;
/** A scope that IS a set operation: its first operand is a parenthesised branch. */
const SET_OPERATION = /^\s*\(\)\s*(?:UNION|INTERSECT|EXCEPT)\b/i;

function isIntegerShaped(source: string): boolean {
  if (INTEGER_CALL.test(source)) return true;
  if (source.endsWith('()')) return false;
  return INTEGER_COLUMN.test(source.split('.').pop()!);
}

/** Integer-shaped, or timestamp-shaped (a call other than the now() family is judged by its alias). */
function isHazardShaped(source: string, alias: string): boolean {
  if (isIntegerShaped(source) || TIMESTAMP_CALL.test(source)) return true;
  return TIMESTAMP_COLUMN.test(source.endsWith('()') ? alias : source.split('.').pop()!);
}

interface Scope {
  /** The scope's own text, each inner scope flattened to `()`. */
  text: string;
  /** Direct inner scopes' texts, in source order. */
  children: string[];
}

/** Split SQL into parenthesis scopes; each inner scope appears as `()` in its parent. */
function scopes(sqlText: string): Scope[] {
  const out: Scope[] = [];
  const stack: Scope[] = [{ text: '', children: [] }];
  let inQuote = false;
  for (const ch of sqlText) {
    const top = stack[stack.length - 1]!;
    if (inQuote) {
      top.text += ch;
      if (ch === "'") inQuote = false;
    } else if (ch === "'") {
      inQuote = true;
      top.text += ch;
    } else if (ch === '(') {
      stack.push({ text: '', children: [] });
    } else if (ch === ')') {
      if (stack.length > 1) {
        const done = stack.pop()!;
        out.push(done);
        const parent = stack[stack.length - 1]!;
        parent.text += '()';
        parent.children.push(done.text);
      }
    } else {
      top.text += ch;
    }
  }
  return [...out, ...stack];
}

function hazardAliases(scopeText: string): Set<string> {
  return new Set(
    [...scopeText.matchAll(TEXT_ALIAS)].filter((m) => isHazardShaped(m[1]!, m[2]!)).map((m) => m[2]!.toLowerCase()),
  );
}

/** Aliases that an ORDER BY in this literal sorts as text although they hold integers. */
function textAliasOrderHazards(sqlText: string): string[] {
  const clean = sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(CAST_CALL, '$1::text');
  const found: string[] = [];
  for (const { text: scope, children } of scopes(clean)) {
    const aliases = hazardAliases(scope);
    // A set operation's ORDER BY sorts by the output names of its FIRST branch.
    if (SET_OPERATION.test(scope) && children[0] !== undefined) {
      for (const a of hazardAliases(children[0])) aliases.add(a);
    }
    if (aliases.size === 0) continue;
    for (const m of scope.matchAll(ORDER_BY)) {
      const rest = scope.slice(m.index! + m[0].length);
      const end = rest.search(CLAUSE_END);
      for (const raw of (end < 0 ? rest : rest.slice(0, end)).split(',')) {
        const item = raw.trim().replace(/\s+NULLS\s+(?:FIRST|LAST)$/i, '').replace(/\s+(?:ASC|DESC)$/i, '').trim();
        const bare = /^"?([A-Za-z_]\w*)"?$/.exec(item);
        if (bare && aliases.has(bare[1]!.toLowerCase())) found.push(bare[1]!);
      }
    }
  }
  return found;
}

function literalText(n: ts.Node): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ${} ');
  return null;
}

interface Site {
  file: string;
  line: number;
  aliases: string[];
  /** Whitespace-collapsed literal text, `${}` for interpolations. */
  text: string;
}

function scanSource(file: string, text: string): Site[] {
  if (!/ORDER\s+BY/i.test(text) || !/::\s*\w|CAST\s*\(/i.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: Site[] = [];
  const visit = (n: ts.Node) => {
    const lit = literalText(n);
    if (lit !== null) {
      const aliases = textAliasOrderHazards(lit);
      if (aliases.length) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        sites.push({ file, line, aliases, text: lit.replace(/\s+/g, ' ') });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

/**
 * Flagged sites that are correct as written. Keyed by file plus a substring of the
 * whitespace-collapsed literal (not a line number, which drifts). An entry that stops
 * matching fails the guard, so the list cannot rot, and each entry doubles as a
 * positive control that the scan still reads that file.
 */
const UUID_REASON =
  'is a uuid column: canonical uuid text is fixed-width lowercase hex, so its text order equals uuid (byte) order';
const EXEMPT: ReadonlyArray<{ file: string; contains: string; reason: string }> = [
  {
    file: 'libs/papercusp/packages/locks/src/resource-lock-store.ts',
    contains: 'SELECT ticket_id::text AS ticket_id',
    reason: `agent_resource_exclusive_queue.ticket_id ${UUID_REASON}.`,
  },
  {
    file: 'packages/operator-core/lib/memory/recall-staleness.ts',
    contains: 'SELECT memory_id::text AS memory_id',
    reason: `harness_shared.memory_anchors.memory_id ${UUID_REASON}.`,
  },
  {
    file: 'packages/operator-core/lib/cupboard/trigger-pack-lifecycle.ts',
    contains:
      'SELECT id::text AS id, plan_slug AS "planSlug", armed, pack_installation_id::text AS "packInstallationId" FROM harness_shared.trigger_bindings',
    reason: `harness_shared.trigger_bindings.id ${UUID_REASON}.`,
  },
  {
    file: 'packages/operator-core/lib/data-governance/hosted-customer-deletion-store.ts',
    contains: 'SELECT id::text AS id, status, identity_provider, external_organization_id',
    reason: `papercusp_auth.organizations.id ${UUID_REASON}, so the FOR UPDATE lock order is the same either way.`,
  },
  {
    file: 'packages/operator-core/lib/data-governance/organization-backup-sealing.ts',
    contains: 'SELECT id::text AS id FROM harness_shared.data_source_legal_holds',
    reason: `harness_shared.data_source_legal_holds.id ${UUID_REASON}.`,
  },
  {
    file: 'packages/operator-core/lib/data-governance/organization-data-receipts.ts',
    contains: 'SELECT id::text AS id FROM harness_shared.customer_workspaces',
    reason:
      'harness_shared.customer_workspaces.id is already a text column: the ::text cast is a no-op, so the alias sorts exactly like the column.',
  },
  {
    file: 'packages/operator-core/lib/data-governance/siem-export-org-audit.ts',
    contains: 'SELECT id::text AS id, organization_id::text AS organization_id, workspace_id::text AS workspace_id',
    reason: `papercusp_auth.organization_audit_events.id ${UUID_REASON}, matching the (recorded_at, id) uuid keyset predicate.`,
  },
  {
    file: 'packages/operator-core/lib/providers/connector-source-health.ts',
    contains: 'SELECT id::text AS id, kind, status, provider_account_id',
    reason: `harness_shared.data_sources.id ${UUID_REASON}.`,
  },
];

/**
 * `TEXT_ALIAS_ORDER_GUARD_SUBJECT=<repo-relative path>=<absolute path>` scans the second file
 * in place of the first, so scripts/mutation-probe.sh can prove the tree rule falsifiable
 * against a mutated COPY without touching the shared tree.
 */
function subjectOverride(): Map<string, string> {
  const raw = process.env.TEXT_ALIAS_ORDER_GUARD_SUBJECT;
  const eq = raw ? raw.indexOf('=') : -1;
  return eq > 0 ? new Map([[raw!.slice(0, eq), raw!.slice(eq + 1)]]) : new Map();
}

function scanTree() {
  const tracked = listTrackedFiles(REPO_ROOT);
  const files = (tracked.files as string[]).filter(
    (f) => SCAN_PREFIXES.some((p) => f.startsWith(p)) && SOURCE_FILE.test(f) && !NOT_SOURCE.test(f),
  );
  const override = subjectOverride();
  const sites: Site[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(override.get(f) ?? resolve(REPO_ROOT, f), 'utf8');
    } catch {
      continue; // tracked but deleted in the working tree
    }
    sites.push(...scanSource(f, text));
  }
  return { files, sites };
}

describe('ORDER BY never sorts an integer or timestamp column through its text alias (WI-10004608, WI-10004628)', () => {
  describe('detector controls', () => {
    const h = textAliasOrderHazards;

    it('flags the keyset and top-1 shapes that shipped', () => {
      expect(h('SELECT id::text AS id, kind FROM t WHERE id > ${} ORDER BY id ASC LIMIT ${}')).toEqual(['id']);
      expect(h("SELECT id::text AS id FROM t WHERE body->>'k' = 'intent' ORDER BY id DESC LIMIT 1")).toEqual(['id']);
      expect(h('SELECT u.id::text AS id FROM t u ORDER BY id')).toEqual(['id']);
    });

    it('flags CAST, quoted aliases, NULLS ordering, multi-key ordering and count aliases', () => {
      expect(h('SELECT CAST(id AS text) AS id FROM t ORDER BY id')).toEqual(['id']);
      expect(h('SELECT id::text AS "id" FROM t ORDER BY "id" DESC NULLS LAST')).toEqual(['id']);
      expect(h('SELECT owner_id::text AS owner_id, ts FROM t ORDER BY ts, owner_id')).toEqual(['owner_id']);
      expect(h('SELECT kind, count(*)::text AS n FROM t GROUP BY kind ORDER BY n DESC')).toEqual(['n']);
    });

    it('flags a subquery whose own ORDER BY sorts its text alias', () => {
      expect(h('SELECT * FROM a WHERE x = (SELECT id::text AS id FROM t ORDER BY id DESC LIMIT 1)')).toEqual(['id']);
    });

    it('does not flag the fixed forms', () => {
      expect(h('SELECT id::text AS id FROM t WHERE id > ${} ORDER BY id::bigint ASC LIMIT ${}')).toEqual([]);
      expect(h('SELECT u.id::text AS id FROM t u ORDER BY u.id')).toEqual([]);
      expect(h('SELECT id::text AS id FROM personal_documents ORDER BY personal_documents.id')).toEqual([]);
      expect(h('SELECT id::text AS id FROM data_sources ORDER BY data_sources.id')).toEqual([]);
      expect(h('SELECT id::text AS ref FROM t ORDER BY id')).toEqual([]);
    });

    it('ignores window and aggregate ORDER BYs, which bind to input columns', () => {
      expect(h('SELECT id::text AS id, row_number() OVER (ORDER BY id) AS rn FROM t')).toEqual([]);
      expect(h('SELECT id::text AS id, array_agg(x ORDER BY id) FROM t GROUP BY id')).toEqual([]);
    });

    it('ignores SQL comments and aliases whose text order is their value order', () => {
      expect(h('SELECT id::text AS id FROM t -- a bare ORDER BY id would bind to the alias\n ORDER BY id::bigint')).toEqual([]);
      // a date renders without an offset, so its text order is its date order
      expect(h('SELECT ran_on::text AS ran_on FROM t ORDER BY ran_on')).toEqual([]);
      expect(h("SELECT 'x'::text AS row_kind FROM t ORDER BY row_kind")).toEqual([]);
    });

    it('flags a timestamp text alias, whose text carries the session UTC offset (WI-10004628)', () => {
      expect(h('SELECT created_at::text AS created_at FROM t ORDER BY created_at DESC')).toEqual(['created_at']);
      expect(h('SELECT fleet_slug, at::text AS at FROM e WHERE owner_id = ${} ORDER BY at DESC, id DESC')).toEqual(['at']);
      expect(h('SELECT COALESCE(ts, ingested_at)::text AS ts FROM t ORDER BY ts')).toEqual(['ts']);
      expect(h('SELECT now()::text AS seen FROM t ORDER BY seen')).toEqual(['seen']);
    });

    it('flags the outer ORDER BY of a set operation over text-aliased branches', () => {
      expect(
        h('(SELECT invoked_at::text AS ts FROM a ORDER BY invoked_at DESC) UNION ALL (SELECT x::text AS ts FROM b) ORDER BY ts DESC LIMIT ${}'),
      ).toEqual(['ts']);
    });

    it('does not flag the fixed timestamp forms', () => {
      expect(h('SELECT created_at::text AS created_at FROM t ORDER BY t.created_at DESC')).toEqual([]);
      expect(h('SELECT DISTINCT ON (owner_id) updated_at::text AS updated_at FROM c ORDER BY owner_id, c.updated_at DESC')).toEqual([]);
      expect(
        h('SELECT * FROM ((SELECT invoked_at::text AS ts FROM a) UNION ALL (SELECT ts::text AS ts FROM b ORDER BY b.ts DESC)) u ORDER BY u.ts::timestamptz DESC'),
      ).toEqual([]);
    });

    it('reports file and line from a TypeScript source', () => {
      const sites = scanSource('fixture.ts', 'const a = 1;\nconst r = await sql`SELECT id::text AS id FROM t ORDER BY id`;');
      expect(sites.map((s) => [s.file, s.line, s.aliases])).toEqual([['fixture.ts', 2, ['id']]]);
    });
  });

  describe('the tree', () => {
    const { files, sites } = scanTree();

    it('scans the source tree including the libs/papercusp submodule', () => {
      expect(files.length).toBeGreaterThan(1000);
      expect(files).toContain('libs/papercusp/packages/locks/src/resource-lock-store.ts');
      expect(files).toContain('packages/operator-core/lib/endpoint-route/routes/activity/stream.ts');
    });

    it('has no ORDER BY over an integer or timestamp text alias without a written reason', () => {
      const unexplained = sites
        .filter((s) => !EXEMPT.some((e) => e.file === s.file && s.text.includes(e.contains)))
        .map((s) => `${s.file}:${s.line} [${s.aliases.join(',')}] ${s.text.slice(0, 140)}`);
      expect(
        unexplained,
        'ORDER BY the column, not its text alias: write ORDER BY t.col (or id::bigint / ts::timestamptz), ' +
          'or add an EXEMPT entry saying why text order is correct for this column',
      ).toEqual([]);
    });

    it('has no stale or unexplained exemption (each one is also a positive control)', () => {
      for (const e of EXEMPT) expect(e.reason.length, e.contains).toBeGreaterThan(60);
      const stale = EXEMPT.filter((e) => !sites.some((s) => s.file === e.file && s.text.includes(e.contains)));
      expect(stale.map((e) => `${e.file} :: ${e.contains}`)).toEqual([]);
    });
  });
});

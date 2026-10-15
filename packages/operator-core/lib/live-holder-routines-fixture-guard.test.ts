/**
 * EI-21829223595077387 recurrence guard: every hand-built integration fixture that
 * reaches a `liveHolderFragment` consumer must provision `harness_shared.routines`.
 *
 * EI-21431501901242395 added an armed-loop UNION leg to `liveHolderFragment`
 * (work-items-stale-claims.ts) that reads `harness_shared.routines`. Every reader built on
 * the fragment (work-queue-health, fleet-monitors, placement-watchdog, work-items-hold-open,
 * the stale-claim reapers) now reads a table its own source never names. Fixtures that
 * built their schema by hand kept passing their own review and went red with
 * `relation "harness_shared.routines" does not exist`. Integration files sit outside the
 * gate's affected radius, so nothing noticed until a sweep ran them.
 *
 * `LIVE_HOLDER_ROUTINES_DDL` (test/_pg-helpers.ts) is the single shared provision. This
 * guard fails an integration test under lib/ that imports a fragment consumer AND builds
 * its schema by hand (inline `CREATE TABLE` or the `_work-items-schema` fixture) without
 * either referencing that constant or creating `harness_shared.routines` itself. Files
 * that apply the real migration chain get the full schema and are exempt.
 *
 * Known limit: consumers are matched one import hop deep (a fixture that reaches the
 * fragment only through a module that imports a consumer is not seen), and fixtures that
 * build their schema inside a helper module (composition-rig, _org-test-db) are classified
 * by the test file's own source only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  stripCommentsAndStrings,
  stripCommentsOnly,
} from '../../../scripts/lib/strip-comments-and-strings.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FRAGMENT_MODULE = path.join(HERE, 'work-items-stale-claims.ts');
const PG_HELPERS = path.join(HERE, '..', 'test', '_pg-helpers.ts');

const CONSUMER_CALL_RE = /\bliveHolderFragment\s*\(/;
const PROVISION_CONST_RE = /\bLIVE_HOLDER_ROUTINES_DDL\b/;
const INLINE_ROUTINES_DDL_RE =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?harness_shared\.routines\b/i;
const REAL_MIGRATIONS_RE = /\bapplyMigrationsForTest\s*\(/;
const INLINE_DDL_RE = /\bCREATE\s+TABLE\b/i;
const SCHEMA_FIXTURE_IMPORT_RE = /from\s+['"][^'"]*test\/_work-items-schema['"]/;
const STATIC_IMPORT_RE = /\bimport\s+(type\s+)?[^;'"]*?\bfrom\s*(['"])([^'"\n]+)\2/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

/** Relations `liveHolderFragment`'s own body reads, beyond `activeSessionHolderFragment`. */
const FRAGMENT_EXTRA_RELATIONS = ['routines'];
/** Columns of `harness_shared.routines` the fragment reads. */
const FRAGMENT_ROUTINES_COLUMNS = ['target_owner_id', 'reschedule_interval_sec', 'active'];

/**
 * Files that import a fragment consumer on a hand-built schema but do not reach the
 * fragment. Each entry needs a reason; the self-check below fails once an entry stops
 * being a violation, so the list cannot go stale.
 */
const ALLOW: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'shared-pot-loop/scan-outbox-health.integration.test.ts',
    'imports only scanOutboxHealth from fleet-monitors, which reads substrate_outbox and never calls liveHolderFragment',
  ],
]);

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

const noExt = (p: string) => p.replace(/\.(?:[cm]?[jt]s)$/, '');

/** Non-test modules under lib/ that call `liveHolderFragment`, as extensionless absolute paths. */
export function findConsumerModules(root: string): string[] {
  return walk(root, (n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts'))
    .filter((full) => CONSUMER_CALL_RE.test(stripCommentsAndStrings(readFileSync(full, 'utf8'), full) as string))
    .map(noExt);
}

/** True when `commentless` imports one of `consumers` by value (resolved relative path). */
export function importsConsumer(commentless: string, fileName: string, consumers: readonly string[]): boolean {
  const specifiers: string[] = [];
  for (const m of commentless.matchAll(STATIC_IMPORT_RE)) if (!m[1]) specifiers.push(m[3]);
  for (const m of commentless.matchAll(DYNAMIC_IMPORT_RE)) specifiers.push(m[2]);
  const dir = path.dirname(fileName);
  const wanted = new Set(consumers);
  return specifiers.some((spec) => spec.startsWith('.') && wanted.has(noExt(path.resolve(dir, spec))));
}

export type Classification =
  | { kind: 'not-consumer' }
  | { kind: 'real-migrations' }
  | { kind: 'not-hand-built' }
  | { kind: 'ok' }
  | { kind: 'violation' };

/** Classify one integration test source. */
export function classify(raw: string, fileName: string, consumers: readonly string[]): Classification {
  // Identifiers and calls: comments AND strings removed, so prose cannot count.
  const code = stripCommentsAndStrings(raw, fileName) as string;
  // DDL and import specifiers live in string literals: only comments removed.
  const commentless = stripCommentsOnly(raw, fileName) as string;
  if (!importsConsumer(commentless, fileName, consumers)) return { kind: 'not-consumer' };
  if (REAL_MIGRATIONS_RE.test(code)) return { kind: 'real-migrations' };
  if (PROVISION_CONST_RE.test(code) || INLINE_ROUTINES_DDL_RE.test(commentless)) return { kind: 'ok' };
  const handBuilt = INLINE_DDL_RE.test(commentless) || SCHEMA_FIXTURE_IMPORT_RE.test(commentless);
  return handBuilt ? { kind: 'violation' } : { kind: 'not-hand-built' };
}

/** Source text of `export function liveHolderFragment(...) { ... }`. */
function fragmentBody(): string {
  const src = readFileSync(FRAGMENT_MODULE, 'utf8');
  const start = src.indexOf('export function liveHolderFragment(');
  expect(start, 'liveHolderFragment is no longer exported from work-items-stale-claims.ts').toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

describe('live-holder routines fixture guard (EI-21829223595077387)', () => {
  const consumers = findConsumerModules(HERE);
  const results = walk(HERE, (n) => n.endsWith('.integration.test.ts')).map((full) => ({
    rel: path.relative(HERE, full),
    verdict: classify(readFileSync(full, 'utf8'), full, consumers),
  }));

  it('the fragment still reads exactly the relations this guard provisions', () => {
    const body = fragmentBody();
    const relations = [...new Set([...body.matchAll(/harness_shared\.(\w+)/g)].map((m) => m[1]))].sort();
    expect(
      relations,
      'liveHolderFragment now reads a different set of relations. Provision any new one in a shared ' +
        'test DDL constant (test/_pg-helpers.ts), extend FRAGMENT_EXTRA_RELATIONS and this guard, or ' +
        'retire the guard if the routines leg was removed.',
    ).toEqual(FRAGMENT_EXTRA_RELATIONS);
    for (const col of FRAGMENT_ROUTINES_COLUMNS) expect(body).toMatch(new RegExp(`\\b${col}\\b`));
  });

  it('LIVE_HOLDER_ROUTINES_DDL provisions every routines column the fragment reads', () => {
    const helpers = readFileSync(PG_HELPERS, 'utf8');
    const m = helpers.match(/export const LIVE_HOLDER_ROUTINES_DDL = `([\s\S]*?)`;/);
    expect(m, 'LIVE_HOLDER_ROUTINES_DDL is no longer exported from test/_pg-helpers.ts').not.toBeNull();
    const ddl = m![1];
    expect(ddl).toMatch(INLINE_ROUTINES_DDL_RE);
    for (const col of FRAGMENT_ROUTINES_COLUMNS) expect(ddl).toMatch(new RegExp(`\\b${col}\\b`));
  });

  it('discovers the real consumer population (positive control)', () => {
    const rel = consumers.map((c) => path.relative(HERE, c));
    // A renamed fragment or a broken strip would empty this list and make the guard vacuous.
    expect(rel).toEqual(
      expect.arrayContaining([
        'work-items-stale-claims',
        'work-queue-health',
        'shared-pot-loop/fleet-monitors',
        'pot/placement-watchdog',
        'work-items-hold-open',
      ]),
    );
    const ok = results.filter((r) => r.verdict.kind === 'ok').map((r) => r.rel);
    expect(ok).toEqual(
      expect.arrayContaining([
        'work-queue-health.integration.test.ts',
        'shared-pot-loop/fleet-monitors-orphan-sweep.integration.test.ts',
      ]),
    );
  });

  it('every hand-built fixture that reaches a fragment consumer provisions harness_shared.routines', () => {
    const violations = results
      .filter((r) => r.verdict.kind === 'violation' && !ALLOW.has(r.rel))
      .map((r) => r.rel)
      .sort();
    expect(
      violations,
      'These integration tests import a liveHolderFragment consumer on a hand-built schema without ' +
        'provisioning harness_shared.routines. Import LIVE_HOLDER_ROUTINES_DDL from test/_pg-helpers ' +
        'and run it after the base schema (it is IF NOT EXISTS).',
    ).toEqual([]);
  });

  it('every ALLOW entry is still a live violation (no stale allowlist)', () => {
    for (const rel of ALLOW.keys()) {
      expect(results.find((r) => r.rel === rel)?.verdict.kind, `${rel}: drop its ALLOW entry`).toBe('violation');
    }
  });

  it('classify separates provisioned, unprovisioned and exempt fixtures (self-check)', () => {
    const file = path.join(HERE, 'fake', 'probe.integration.test.ts');
    const consumer = [noExt(path.join(HERE, 'work-queue-health.ts'))];
    const head = `import { readWorkQueueHealth } from '../work-queue-health';\n`;
    const ddl = 'await sql.unsafe(`CREATE TABLE harness_shared.work_items (id text)`);\n';
    expect(classify(head + ddl, file, consumer).kind).toBe('violation');
    // A mention in a comment is not a provision.
    expect(classify(head + ddl + '// LIVE_HOLDER_ROUTINES_DDL\n', file, consumer).kind).toBe('violation');
    expect(
      classify(head + `import { LIVE_HOLDER_ROUTINES_DDL } from '../../test/_pg-helpers';\n` + ddl + 'await sql.unsafe(LIVE_HOLDER_ROUTINES_DDL);\n', file, consumer).kind,
    ).toBe('ok');
    expect(
      classify(head + ddl + 'await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.routines (id text)`);\n', file, consumer).kind,
    ).toBe('ok');
    expect(classify(head + ddl + 'await applyMigrationsForTest(sql);\n', file, consumer).kind).toBe('real-migrations');
    expect(classify(head + 'const db = await createOrgTestDb();\n', file, consumer).kind).toBe('not-hand-built');
    expect(classify(`import type { X } from '../work-queue-health';\n` + ddl, file, consumer).kind).toBe('not-consumer');
  });
});

/**
 * Pins the BM25 configuration page (plan bm25-lexical-search-evoke-adoption-2026-10-10,
 * requirement R-15, item P-010) to the code it describes.
 *
 * The page is authored through docs:author and projected into the docs tree. Every value it
 * states that the code also owns (flag key, preload list, availability signal, compaction
 * mode, schedule, lock timeout, advisory lock, reclaim thresholds) is read from that code
 * here, so a change to any of them fails this test until the page is updated with it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import {
  BM25_MAX_BLOAT_RATIO,
  BM25_RECLAIM_MIN_BYTES,
  CONCURRENT_DDL_LOCK_TIMEOUT,
} from '../search/lexical/bm25-maintenance';
import { BM25_CORPORA } from '../search/lexical/corpora';

const REPO = new URL('../../../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, REPO), 'utf8');

// Overridable so scripts/mutation-probe.sh can point the test at a mutated COPY of the page
// (copy-out mode) instead of mutating the shared tree. An absolute path resolves as-is.
const DOC = read(
  process.env.BM25_CONFIG_DOC_PATH ??
    'apps/operator-docs/src/content/docs/agent-insights/pg-textsearch-bm25-configuration.mdx',
);
const MIGRATION_1447 = read('libs/papercusp/libs/db/sql/1447-bm25-pg-textsearch-indexes.sql');
const EMBEDDED_PG_PATH = 'libs/papercusp/packages/embedded-postgres-server/src/index.js';
const EMBEDDED_PG = read(EMBEDDED_PG_PATH);
const PERIODIC = read('packages/operator-core/lib/dbos/periodic-workflows.ts');
const MAINTENANCE = read('packages/operator-core/lib/search/lexical/bm25-maintenance.ts');
const RANK = read('packages/operator-core/lib/search/lexical/rank.ts');

function section(heading: string): string {
  const start = DOC.indexOf(`## ${heading}`);
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
  const next = DOC.indexOf('\n## ', start + heading.length + 3);
  return DOC.slice(start, next >= 0 ? next : undefined);
}

describe('pg_textsearch (BM25) configuration page', () => {
  it('states the preload requirement and the signal that proves the library is loaded', () => {
    const preload = section('Preload is mandatory');
    expect(preload).toContain('`shared_preload_libraries`');
    expect(preload).toContain('`CREATE EXTENSION pg_textsearch` is **not** enough');
    expect(preload).toContain('restart');

    const signal = "current_setting('pg_textsearch.library_version', true)";
    expect(preload).toContain(signal);
    expect(MIGRATION_1447).toContain(signal);
    expect(RANK).toContain(signal);

    expect(preload).toContain('`skipped:library-not-preloaded`');
    expect(MIGRATION_1447).toContain("'skipped:library-not-preloaded'");
  });

  it('names the preload list embedded PG and pg-autotune actually use', () => {
    const list = /export const OPTIONAL_PRELOAD_LIBRARIES = Object\.freeze\((\[[^\]]*\])\)/.exec(EMBEDDED_PG);
    expect(list, 'OPTIONAL_PRELOAD_LIBRARIES not found in embedded-postgres-server').not.toBeNull();
    const libraries = JSON.parse(list![1]!.replace(/'/g, '"')) as string[];
    expect(libraries).toContain('pg_textsearch');
    expect(DOC).toContain(`\`OPTIONAL_PRELOAD_LIBRARIES\` (\`${JSON.stringify(libraries).replace(/"/g, "'")}\`)`);
    expect(DOC).toContain(`\`${EMBEDDED_PG_PATH}\``);
    expect(read('scripts/pg-autotune.ts')).toContain('presentPreloadLibraries(');
  });

  it('names the kill-switch flag by its real key', () => {
    expect(DOC).toContain(`\`${FLAGS.BM25_LEXICAL_RANKING}\``);
  });

  it('documents explicit index naming through to_bm25query with the registry index names', () => {
    const naming = section('Name the index explicitly in every query');
    expect(naming).toContain("to_bm25query($query, 'harness_shared.work_items_bm25')");
    expect(RANK).toContain('to_bm25query(');
    expect(BM25_CORPORA.map(c => c.indexName)).toContain('work_items_bm25');
    expect(naming).toContain('`lexicalLeg()`');
  });

  // SPEC-P-010: the docs identify the lexical seam as the ONLY entry point for lexical ranking.
  // Falsifier: a doc names another lexical entry point. The entry points are derived from the
  // code: every rank.ts export that returns a ranking leg AND is imported by production code.
  it('names the seam as the only lexical entry point, with exactly the leg functions production code uses (SPEC-P-010)', () => {
    const legReturning = new Set(
      [...RANK.matchAll(/export (?:async )?function (\w+)\([^)]*\):\s*(?:Promise<)?LexicalLeg\b/g)].map(m => m[1]!),
    );
    const importers = execFileSync(
      'git',
      ['grep', '-l', '-E', String.raw`from '([./a-z@-]*/lexical/rank|\./rank)'`, '--', '*.ts', ':!*.test.ts', ':!*.spec.ts'],
      { cwd: REPO, encoding: 'utf8' },
    ).trim().split('\n').filter(f => f && !f.endsWith('search/lexical/rank.ts'));
    const imported = new Set<string>();
    for (const f of importers) {
      for (const m of read(f).matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*rank'/g)) {
        for (const name of m[1]!.split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!)) imported.add(name);
      }
    }
    const entryPoints = [...legReturning].filter(n => imported.has(n)).sort();
    // Detector-shaped: the derivation must find the seam's main entry point, or this test is vacuous.
    expect(entryPoints).toContain('lexicalLeg');

    const fnsIn = (s: string) => [...s.matchAll(/`(\w+)\(\)`/g)].map(m => m[1]!);
    const sentences = (text: string) => text.split(/(?<=[.:;])\s+(?=[A-Z`])/);
    const claim = sentences(section('Name the index explicitly in every query')).filter(s => /only entry point/i.test(s));
    expect(claim, 'exactly one sentence states the only entry point').toHaveLength(1);
    expect(claim[0]).toContain('`packages/operator-core/lib/search/lexical/rank.ts`');
    expect([...new Set(fnsIn(claim[0]!))].sort(), 'the entry-point sentence names exactly the leg functions in use').toEqual(entryPoints);

    const ARCH = read(
      process.env.BM25_ARCH_DOC_PATH ??
        'apps/operator-docs/src/content/docs/agent-insights/lexical-leg-is-ts-rank-cd-not-bm25.mdx',
    );
    for (const [name, text] of [['configuration page', DOC], ['architecture page', ARCH]] as const) {
      for (const s of sentences(text).filter(x => /entry point|one seam|goes? through/i.test(x))) {
        for (const fn of fnsIn(s)) {
          expect(entryPoints, `${name} names \`${fn}()\` as a way into lexical ranking: "${s.slice(0, 160)}"`).toContain(fn);
        }
      }
    }
  });

  it('pins manual compaction, the maintenance schedule and the reclaim thresholds to the code', () => {
    const compaction = section('Compaction is manual, and maintenance owns it');
    expect(compaction).toContain("compaction = 'manual'");
    expect(MIGRATION_1447).toContain("c.text_config, 'manual')");

    const cron = /registerScheduled\(bm25MaintenanceWorkflow, \{[^}]*crontab: '([^']+)'/.exec(PERIODIC);
    expect(cron, 'bm25Maintenance crontab not found').not.toBeNull();
    expect(compaction).toContain(`crontab \`${cron![1]}\``);

    expect(compaction).toContain(`${BM25_MAX_BLOAT_RATIO}x its estimated live bytes`);
    expect(compaction).toContain(`at least ${BM25_RECLAIM_MIN_BYTES} bytes (${BM25_RECLAIM_MIN_BYTES / 1024} KiB)`);
  });

  it('marks the older ts_rank_cd page superseded and points it at this page', () => {
    const legacy = read('apps/operator-docs/src/content/docs/agent-insights/lexical-leg-is-ts-rank-cd-not-bm25.mdx');
    expect(legacy).toMatch(/^status: superseded$/m);
    expect(legacy).toContain('(/internal/docs/agent-insights/pg-textsearch-bm25-configuration)');
    expect(DOC).toContain('(/internal/docs/agent-insights/lexical-leg-is-ts-rank-cd-not-bm25)');
  });

  it('documents the D-016 exact list with the real cap, the merge function and the kept corpora', () => {
    const exact = section('Exact-list corpora (D-016)');
    const cap = RANK.match(/export const EXACT_LIST_MAX_AND_ROWS = (\d+);/);
    expect(cap, 'EXACT_LIST_MAX_AND_ROWS not found in rank.ts').not.toBeNull();
    expect(exact).toContain(`\`EXACT_LIST_MAX_AND_ROWS\` (\`${cap![1]}\`)`);
    expect(RANK).toContain('export function mergeExactAndBm25');
    expect(exact).toContain('`mergeExactAndBm25()`');

    // The page must name exactly the corpora the registry keeps, so adding or dropping an
    // exact list without updating the page fails here.
    const keeps = (c: (typeof BM25_CORPORA)[number]) => 'keepLegacyColumn' in c && c.keepLegacyColumn === 'exact-list';
    expect(BM25_CORPORA.filter(keeps).length).toBeGreaterThan(0);
    for (const c of BM25_CORPORA) {
      const named = exact.includes(`\`harness_shared.${c.table}\` (\`${c.legacyTsvColumn}\`)`);
      expect(named, `${c.table}: page and registry disagree on keepLegacyColumn`).toBe(keeps(c));
    }

    // Retirement must say it skips them.
    expect(section('Compaction is manual, and maintenance owns it')).toContain('`kept:exact-list`');
  });

  it('names the merge method the code actually uses (D-032: interleave, not RRF)', () => {
    const exact = section('Exact-list corpora (D-016)');
    const start = RANK.indexOf('export function mergeExactAndBm25');
    expect(start, 'mergeExactAndBm25 not found in rank.ts').toBeGreaterThanOrEqual(0);
    const end = RANK.indexOf('\n}\n', start);
    expect(end, 'mergeExactAndBm25 body end not found').toBeGreaterThan(start);
    const body = RANK.slice(start, end);
    // Derived from the function body, so switching the merge back to RRF (or to anything
    // else) fails here until the page says so.
    const usesRrf = body.includes('rrfCombine(');
    expect(exact.includes('by reciprocal-rank fusion over row identity')).toBe(usesRrf);
    expect(exact.includes('by interleaving over row identity')).toBe(!usesRrf);
  });

  it('pins the CONCURRENTLY lock_timeout and the advisory lock name to the maintenance module', () => {
    const trap = section('Compaction is manual, and maintenance owns it');
    expect(trap).toContain(`\`lock_timeout\` of \`${CONCURRENT_DDL_LOCK_TIMEOUT}\``);
    const lock = /const RECLAIM_LOCK = '([^']+)'/.exec(MAINTENANCE);
    expect(lock, 'RECLAIM_LOCK not found in bm25-maintenance.ts').not.toBeNull();
    expect(trap).toContain(`\`${lock![1]}\``);
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';
import * as realCensus from './work-selection-census';

// scripts/mutation-probe.sh (copy-out mode) points this at a mutated copy of the census module to
// prove the scan fails when a row or exclusion goes missing. The module has no imports, so a copy
// outside the tree loads the same way.
const census: typeof realCensus = process.env.WORK_SELECTION_CENSUS_MODULE
  ? await import(process.env.WORK_SELECTION_CENSUS_MODULE)
  : realCensus;
const { WORK_SELECTION_CENSUS, WORK_SELECTION_SCAN, WORK_SELECTION_SCAN_EXCLUSIONS, WORK_SELECTION_SEED_ROWS } = census;

// Repo root = packages/operator-core/lib/../../..
const ROOT = resolve(__dirname, '..', '..', '..');

/**
 * Agent-tool leg: non-test .ts files under the agent-tools dir whose comment-stripped text reads a
 * work table or calls a work decider. Comments only are stripped, because the SQL being detected
 * lives inside template strings. The raw-text prefilter keeps the TypeScript parse off files that
 * cannot match.
 */
function scanAgentToolSites(dir: string = join(ROOT, WORK_SELECTION_SCAN.agentToolsDir)): string[] {
  const { tableRead, deciderCall } = WORK_SELECTION_SCAN;
  const sites: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isFile() || !name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    const abs = join(entry.parentPath, name);
    const raw = readFileSync(abs, 'utf8');
    if (!tableRead.test(raw) && !deciderCall.test(raw)) continue;
    const code = stripCommentsOnly(raw, abs);
    if (tableRead.test(code) || deciderCall.test(code)) sites.push(relative(ROOT, abs));
  }
  return sites.sort();
}

/** SQL leg: view names (schema dropped) whose CREATE VIEW body in any migration reads a work table. */
function scanSqlViewSites(dir: string = join(ROOT, WORK_SELECTION_SCAN.sqlDir)): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue;
    const raw = readFileSync(join(dir, file), 'utf8');
    if (!/\bVIEW\b/i.test(raw)) continue;
    const sql = stripCommentsOnly(raw, file);
    for (const m of sql.matchAll(WORK_SELECTION_SCAN.createView)) {
      const body = m[0].slice(m[0].indexOf(m[1]) + m[1].length);
      if (WORK_SELECTION_SCAN.viewBodyRead.test(body)) names.add(m[1].replace(/"/g, '').replace(/^harness_shared\./, ''));
    }
  }
  return [...names].sort();
}

const coveredFiles = new Set(
  WORK_SELECTION_CENSUS.flatMap((r) => [r.file, ...(r.sites ?? []).map((s) => s.file)]),
);
const coveredViews = new Set(WORK_SELECTION_CENSUS.flatMap((r) => (r.sqlObject ? [r.sqlObject] : [])));
const excluded = (leg: 'agent-tool' | 'sql-view') =>
  new Set(WORK_SELECTION_SCAN_EXCLUSIONS.filter((e) => e.leg === leg).map((e) => e.target));

describe('work-selection census (enterprise-data-sources P-007)', () => {
  it('every census row points at a file that still contains its kind-decider anchor', () => {
    const stale = WORK_SELECTION_CENSUS.filter((row) => {
      const path = resolve(ROOT, row.file);
      return !existsSync(path) || !readFileSync(path, 'utf8').includes(row.anchor);
    }).map((row) => `${row.id}: ${row.file} no longer contains ${JSON.stringify(row.anchor)}`);
    // A failure here means a decider moved or changed: update the census row (and re-check its
    // admits/reachesNonWork verdict) rather than deleting the row.
    expect(stale).toEqual([]);
  });

  it('every delegating site still contains its call into the row decider', () => {
    const stale = WORK_SELECTION_CENSUS.flatMap((row) =>
      (row.sites ?? []).filter((s) => {
        const path = resolve(ROOT, s.file);
        return !existsSync(path) || !readFileSync(path, 'utf8').includes(s.anchor);
      }).map((s) => `${row.id} site ${s.file} no longer contains ${JSON.stringify(s.anchor)}`),
    );
    expect(stale).toEqual([]);
  });

  describe('completeness scan (WI-10005121): every work_items selection, listing or count site is a census row or a reasoned exclusion', () => {
    const toolSites = scanAgentToolSites();
    const viewSites = scanSqlViewSites();

    it('positive control: the scan finds sites the census already models', () => {
      // If these go missing the scan itself is broken (paths, regexes, comment stripping), and an
      // empty "missing" list below would be vacuous.
      for (const known of ['work_items/claim.ts', 'work_items/claim_next.ts', 'work_items/burn_down.ts', 'scheduler/get_next.ts']) {
        expect(toolSites, known).toContain(`${WORK_SELECTION_SCAN.agentToolsDir}/${known}`);
      }
      expect(viewSites).toEqual(expect.arrayContaining(['work_items_claimable', 'engineer_issues']));
    });

    it('comment-only mentions are not sites, and a call is', () => {
      const code = stripCommentsOnly('// claimWorkItem(x)\n/* FROM harness_shared.work_items */\nconst y = 1;\n', 'fixture.ts');
      expect(WORK_SELECTION_SCAN.deciderCall.test(code) || WORK_SELECTION_SCAN.tableRead.test(code)).toBe(false);
      const live = stripCommentsOnly('const r = await sql`SELECT 1 FROM harness_shared.work_items`;\n', 'fixture.ts');
      expect(WORK_SELECTION_SCAN.tableRead.test(live)).toBe(true);
    });

    it('no agent-tool site is missing from the census', () => {
      const skip = excluded('agent-tool');
      const missing = toolSites.filter((f) => !coveredFiles.has(f) && !skip.has(f));
      // A failure names a new selection/listing/count path. Add a census row (or a `sites` entry
      // on the row whose decider it calls), or an exclusion whose basis really holds.
      expect(missing).toEqual([]);
    });

    it('no work-reading view is missing from the census', () => {
      const skip = excluded('sql-view');
      expect(viewSites.filter((v) => !coveredViews.has(v) && !skip.has(v))).toEqual([]);
    });

    it('exclusions are current, single-classified and reasoned', () => {
      const scanned = { 'agent-tool': new Set(toolSites), 'sql-view': new Set(viewSites) } as const;
      const stale = WORK_SELECTION_SCAN_EXCLUSIONS.filter((e) => !scanned[e.leg].has(e.target)).map((e) => e.target);
      expect(stale, 'excluded targets the scan no longer finds: delete them').toEqual([]);
      const double = WORK_SELECTION_SCAN_EXCLUSIONS.filter((e) =>
        e.leg === 'agent-tool' ? coveredFiles.has(e.target) : coveredViews.has(e.target),
      ).map((e) => e.target);
      expect(double, 'excluded AND covered by a census row').toEqual([]);
      const targets = WORK_SELECTION_SCAN_EXCLUSIONS.map((e) => `${e.leg}:${e.target}`);
      expect(new Set(targets).size).toBe(targets.length);
      for (const e of WORK_SELECTION_SCAN_EXCLUSIONS) expect(e.reason.trim().length, e.target).toBeGreaterThan(0);
    });
  });

  it('census ids are unique and every selection path names its discriminators or evidence', () => {
    const ids = WORK_SELECTION_CENSUS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of WORK_SELECTION_CENSUS.filter((r) => r.role === 'selection')) {
      expect(row.discriminators.length, row.id).toBeGreaterThan(0);
    }
  });

  it('after P-009 no selection path reaches a non-work instance, and the listing paths that still can are named', () => {
    const reaching = WORK_SELECTION_CENSUS.filter((r) => r.reachesNonWork === 'yes');
    // P-009 (D-022, D-024): every claim and placement path applies the work predicate, so a
    // selection row marked 'yes' is a regression, not a census fact.
    expect(reaching.filter((r) => r.role === 'selection').map((r) => r.id)).toEqual([]);
    // Reading a row is not claiming it. The listing rows still show human-audience work (D-021
    // filters nature only), the auxiliary rows and the consolidated view read every row by
    // design, and any claim they lead to is refused by the by-id gate. A new 'yes' row is a
    // decision to record here, not a silent addition.
    expect(reaching.map((r) => r.id).sort()).toEqual([
      'drain-mode',
      'embed-backfill',
      'fleet-metrics-population',
      'list-search-count',
      'spec-enforcement-latency',
      'sql-features-consolidated-view',
    ]);
  });

  it('seed rows cover every nature with work_items instances plus human-audience work, and only agent work is claimable', () => {
    const natures = new Set(WORK_SELECTION_SEED_ROWS.map((r) => r.nature));
    for (const n of ['work', 'record', 'internal-excluded', 'retired'] as const) expect(natures.has(n), n).toBe(true);
    expect(WORK_SELECTION_SEED_ROWS.some((r) => r.nature === 'work' && r.audience === 'human')).toBe(true);
    for (const row of WORK_SELECTION_SEED_ROWS) {
      const agentWork = row.nature === 'work' && row.audience === 'agent';
      expect(row.expectAgentClaimable, `${row.itemKind} ${JSON.stringify(row.payload)}`).toBe(agentWork);
    }
  });
});

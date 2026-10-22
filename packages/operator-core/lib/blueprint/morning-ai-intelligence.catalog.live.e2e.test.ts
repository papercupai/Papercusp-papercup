/** Read-only R5 proof on the current operator. The maintained e2e reporter
 * records execution-time runtime witnesses from the live-profile selectors.
 * Source navigation and the historical Research tab remain separate claims. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareRuntimeReader } from '../../vitest.e2e.config';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
const selectedProfile = profilePath ? JSON.parse(readFileSync(resolve(root, profilePath), 'utf8')) : undefined;

describe.skipIf(!profilePath)('Morning AI Research substrate in the live read-only catalog', () => {
  let origin: string;

  beforeAll(async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    // This acceptance route is intentionally local staging, with no deployment,
    // worker dispatch, publication, permissions or scheduler mutation.
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    expect(profile.runtimeUnits).toEqual(['hono-host:3170']);
    origin = profile.origin;
    const readRuntime = await prepareRuntimeReader();
    const witness = await readRuntime!();
    expect(witness, 'The actual execution runtime must be independently measurable').not.toBeNull();
    expect(witness?.units).toEqual(['hono-host:3170']);
  });

  async function read(script: string, missingReportExpected = false) {
    const { stdout } = await execute('ptool', ['code:run', '--url', origin,
      '--harness', 'papercusp', '--raw', '--json', JSON.stringify({ script })],
    { cwd: root, timeout: 45_000, maxBuffer: 256_000 });
    const result = JSON.parse(stdout);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (missingReportExpected) {
      expect(result.partial).toBe(true);
      expect(result.childFailures).toHaveLength(1);
      expect(result.childFailures[0]).toMatchObject({ tool: 'reports:get', kind: 'semantic',
        result: { ok: false, counts: { ok: 0, failed: 1 }, results: [{ ok: false, error: 'not_found' }] } });
    } else {
      expect(result.partial).not.toBe(true);
      expect(result.childFailures ?? []).toEqual([]);
    }
    expect(result.summary).toBeDefined();
    return result.summary;
  }

  it('serves the existing repo-less research parent and AI child from canonical blueprint source', async () => {
    const observed = await read(`
      const catalog = await tools.blueprint.catalog({ tier: 'builtin' });
      if (!Array.isArray(catalog.blueprints)) throw new Error('Catalog entries unavailable');
      return { blueprints: catalog.blueprints.filter(entry =>
        entry.id === 'research' || entry.id === 'morning-ai-intelligence') };
    `);
    expect(observed.blueprints).toHaveLength(2);
    for (const id of ['research', 'morning-ai-intelligence']) {
      const source = loadBlueprintFromFile(resolve(root,
        `libs/papercusp/packages/harness/blueprints/${id}/blueprint.yaml`)).blueprint;
      const actual = observed.blueprints.find((entry: { id: string }) => entry.id === id);
      expect(actual).toMatchObject({ id, tier: 'builtin', version: source.version,
        workItemKind: 'task', decider: 'research-director', requiresRepo: false });
      expect(actual.error).toBeUndefined();
      expect(source.workItem.kind).toBe('task');
      expect(source.knobs.requiresRepo).toBe(false);
    }
  }, 60_000);

  it('retains the cited substrate history, separate Reports owner and unresolved dedicated-tab provenance', async () => {
    const observed = await read(`
      const record = await tools.conversations.get({ id: 'thread-post:1170339' });
      const post = record.results?.find(entry => entry.id === 'thread-post:1170339')?.post;
      if (!post || typeof post.body !== 'string') throw new Error('Original R5 dossier unavailable');
      return { postId: post.id,
        references: ['harness-blueprint-orchestration-2026-06-03', 'P-017', 'D-016',
          'WI-2874', 'reports-library-2026-09-15'].filter(ref => post.body.includes(ref)),
        unresolved: post.body.includes('old dedicated-tab provenance stays explicitly unresolved'),
        navigationScope: post.body.includes('source evidence, not a native rendered-viewer test'),
        reused: post.body.includes('No parallel engine/store/Research hub was introduced') };
    `);
    expect(observed).toEqual({ postId: 1170339,
      references: ['harness-blueprint-orchestration-2026-06-03', 'P-017', 'D-016',
        'WI-2874', 'reports-library-2026-09-15'],
      unresolved: true, navigationScope: true, reused: true });
  }, 60_000);

  describe.skipIf(!selectedProfile?.dailyEdition)('the selected persisted daily edition', () => {
    const edition = selectedProfile?.dailyEdition;

    it('retains one armed daily operation with the next occurrence at 09:00 in the confirmed timezone', async () => {
      const schedule = selectedProfile.dailySchedule;
      const observed = await read(`
        const inventory = await tools.schedule.inventory({ source: 'routines', name: ${JSON.stringify(selectedProfile?.dailySchedule?.name)} });
        if (!Array.isArray(inventory.rows)) throw new Error('Schedule inventory unavailable');
        return inventory.rows.filter(row => row.name === ${JSON.stringify(selectedProfile?.dailySchedule?.name)});
      `);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ armed: true, cadence: 'cron', lastError: null,
        detail: { targetRole: 'system:blueprint-operation' } });
      expect(schedule.timezone).toBe('America/New_York');
      const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timezone,
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      expect(localTime.format(new Date(observed[0].nextFire))).toBe('09:00');
      expect(localTime.format(new Date(observed[0].lastFire))).toBe('09:00');
      expect(new Date(observed[0].nextFire).getTime()).toBeGreaterThan(Date.now());
    }, 60_000);

    async function readEdition() {
      return read(`
        const result = await tools.reports.get({ id: ${JSON.stringify(edition?.reportId)} });
        const row = result.results?.find(entry => entry.id === ${JSON.stringify(edition?.reportId)});
        if (!row?.ok || !row.report) throw new Error('Selected daily edition unavailable');
        const report = row.report;
        return { title: report.title, body: report.body_md, path: report.path,
          visibility: report.visibility };
      `);
    }

    it('reads the exact dated worker report, its citation and its disclosed partial coverage', async () => {
      const report = await readEdition();
      expect(report.title).toBe(`Papercusp AI Brief — ${edition.editionDate}`);
      expect(report.path).toBe(`/reports?sel=${edition.reportId}`);
      expect(report.visibility).toBe('workspace');
      expect(createHash('sha256').update(report.body).digest('hex')).toBe(edition.bodySha256);
      expect(report.body).toContain(edition.primarySource);
      expect(report.body).toContain(`Source count: ${edition.sourceCount} unique attempted`);
      expect(report.body).toContain('this edition is **partial**');
      for (const gap of edition.coverageText) expect(report.body).toContain(gap);
    }, 60_000);

    it('retains opportunities with existing fit, confidence, limits and a next action', async () => {
      const report = await readEdition();
      const section: string | undefined = report.body.match(/## Papercusp opportunities\n([\s\S]*?)(?=\n## |$)/)?.[1];
      expect(section, 'The actual saved edition must contain the required section').toBeDefined();
      const opportunities = section!.split(/\n(?=\d+\. )/).filter(value => value.trim());
      expect(opportunities.length).toBeGreaterThan(0);
      for (const opportunity of opportunities) {
        expect(opportunity).toContain('Fit:');
        expect(opportunity).toContain('**Confidence:**');
        expect(opportunity).toContain('**Next action:**');
      }
      expect(section).toContain('current adapter seams were not inspected');
      expect(section).toContain('low for broader fleet frequency');
    }, 60_000);

    it('returns not_found for an absent report instead of reusing the selected edition', async () => {
      const missingId = `${edition.reportId}-not-published`;
      const observed = await read(`
        const result = await tools.reports.get({ id: ${JSON.stringify(missingId)} });
        const row = result.results?.find(entry => entry.id === ${JSON.stringify(missingId)});
        if (!row) throw new Error('Missing report result unavailable');
        return { ok: row.ok, error: row.error, hasReport: 'report' in row };
      `, true);
      expect(observed).toEqual({ ok: false, error: 'not_found', hasReport: false });
    }, 60_000);
  });
});

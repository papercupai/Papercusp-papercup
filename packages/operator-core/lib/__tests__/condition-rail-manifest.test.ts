import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { acceptanceProblems, inventoryTree, manifestProblems, scanSites } from '../../../../scripts/lib/condition-rail-inventory.mjs';
import { RAIL_MIGRATION_COMPLETE_ITEMS } from '../degradation/rail-migration-cases';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/evidence/condition-rail-inventory-seed-2026-10-11.json', import.meta.url)), 'utf8'));
const annotationReview = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/evidence/condition-rail-type-annotation-amendments-2026-10-11.json', import.meta.url)), 'utf8'));
const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../scripts/condition-rail-baseline.json', import.meta.url)), 'utf8'));

describe('condition-rail immutable audit manifest (P-017)', () => {
  it('keeps the original goal-liveness producer identity on the rail without a baseline exemption', () => {
    const file = 'packages/operator-core/lib/system-health/goal-liveness-watchdog.ts';
    const id = `bespoke-watchdog|${file}|<module>|1`;
    const sites = scanSites(readFileSync(fileURLToPath(new URL('../../../../' + file, import.meta.url)), 'utf8'), file);
    expect(manifest.rows.find((row: { id: string }) => row.id === id))
      .toMatchObject({ disposition: 'migrate', item: 'P-014', route: 'condition' });
    expect(sites.find(site => site.id === id), id).toMatchObject({ onRail: true });
    expect(baseline.rowIds).not.toContain(id);
  });

  it('keeps goal-drain emissions on the rail at their actual producer sites', () => {
    const file = 'packages/operator-core/lib/system-health/goal-drain-fleet-watchdog.ts';
    const raw = readFileSync(fileURLToPath(new URL('../../../../' + file, import.meta.url)), 'utf8');
    const sites = scanSites(raw, file);
    for (const [kind, enclosing] of [
      ['bespoke-watchdog', '<module>'],
      ['health-flag-no-condition', 'readGoalPlanFleetObservation'],
      ['health-flag-no-condition', 'runRelaunchLeg'],
      ['health-flag-no-condition', 'runGoalDrainFleetSweepOnce'],
    ]) {
      const id = [kind, file, enclosing, 1].join('|');
      expect(sites.find(site => site.id === id), id).toMatchObject({ onRail: true });
      expect(baseline.rowIds, id).not.toContain(id);
    }
  });

  it('pins the original row set and retains reasoned dispositions and routes', () => {
    const pinnedHash = 'a2fdb5475a100101ea8dafb6019d75045cb38e53ef1a5e4870c6670d5abb77e4';
    expect(createHash('sha256').update(JSON.stringify(manifest.rows)).digest('hex')).toBe(pinnedHash);
    expect(manifest.rowsSha256).toBe(pinnedHash);
    expect(manifest.rows).toHaveLength(307);
    expect(manifest.rows.filter((row: { disposition: string }) => row.disposition === 'migrate')).toHaveLength(243);
    expect(manifest.rows.filter((row: { disposition: string }) => row.disposition === 'not-applicable')).toHaveLength(64);
    expect(manifestProblems(manifest, inventoryTree(fileURLToPath(new URL('../../../../', import.meta.url))),
      { completedItems: RAIL_MIGRATION_COMPLETE_ITEMS })).toEqual([]);
  }, 120_000);

  it('applies exactly the 55 independently reviewed annotation exclusions and preserves runtime siblings', () => {
    const approved = annotationReview.proposals;
    expect(annotationReview).toMatchObject({ status: 'applied-reviewed',
      seedRowsSha256: manifest.rowsSha256, reviewerRef: 'thread-post:1176052' });
    expect(approved).toHaveLength(55);
    const ids = approved.map((proposal: { rowId: string }) => proposal.rowId);
    expect(new Set(ids).size).toBe(55);
    expect(manifest.amendments.filter((entry: { reviewerRef: string }) => entry.reviewerRef === annotationReview.reviewerRef)
      .map((entry: { rowId: string }) => entry.rowId).sort()).toEqual([...ids].sort());
    const live = inventoryTree(fileURLToPath(new URL('../../../../', import.meta.url)));

    const kinds: string[] = [];
    for (const proposal of approved) {
      expect(manifest.rows.find((seed: { id: string }) => seed.id === proposal.rowId))
        .toMatchObject({ disposition: 'migrate', item: 'P-014', route: 'condition' });
      expect(manifest.amendments.find((entry: { rowId: string }) => entry.rowId === proposal.rowId))
        .toMatchObject({ change: proposal.change, author: proposal.author, reviewerRef: annotationReview.reviewerRef });
      expect(baseline.rowIds).not.toContain(proposal.rowId);
      const file = proposal.evidence.file;
      const raw = readFileSync(fileURLToPath(new URL(`../../../../${file}`, import.meta.url)), 'utf8');
      const site = scanSites(raw, file).find((candidate: { id: string }) => candidate.id === proposal.rowId);
      expect(site, proposal.rowId).toBeDefined();
      if (!site) throw new Error(`Missing reviewed annotation row ${proposal.rowId}`);
      if (!site.onRail) expect(live.rows.find((row: { id: string }) => row.id === site.id)?.disposition).toEqual(proposal.change);

      // The compiler independently distinguishes declarations from runtime health fields;
      // the lexical inventory must keep these original identities for the immutable audit.
      const source = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
      const declarations: ts.Node[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === 'alert' &&
            source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 === site.line) {
          declarations.push(node.parent);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(declarations, proposal.rowId).toHaveLength(1);
      const declaration = declarations[0];
      expect(ts.SyntaxKind[declaration.kind], proposal.rowId).toBe(proposal.evidence.syntax);
      expect(ts.isPropertyAssignment(declaration)).toBe(false);
      kinds.push(ts.SyntaxKind[declaration.kind]);
      if (ts.isVariableDeclaration(declaration)) {
        expect(declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)).toBe(true);
        const properties = (declaration.initializer as ts.ObjectLiteralExpression).properties;
        expect(properties.some((property) => ts.isPropertyAssignment(property) &&
          /^(alarm|alarming|alert|alerting|degraded|unhealthy|breached)$/.test(property.name.getText(source)))).toBe(false);
      }
    }
    expect(kinds.filter((kind) => kind === 'Parameter')).toHaveLength(53);
    expect(kinds.filter((kind) => kind === 'PropertySignature')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'VariableDeclaration')).toHaveLength(1);
    for (const [file, enclosing] of [
      ['goal-drain-fleet-watchdog.ts', 'readGoalPlanFleetObservation'],
      ['goal-grading-backlog-sweep.ts', 'runGoalGradingBacklogSweepOnce'],
    ]) {
      const path = `packages/operator-core/lib/system-health/${file}`;
      const id = `health-flag-no-condition|${path}|${enclosing}|1`;
      expect(ids).not.toContain(id);
      expect(manifest.amendments.find((entry: { rowId: string }) => entry.rowId === id)).toBeUndefined();
      const site = scanSites(readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8'), path)
        .find((candidate: { id: string }) => candidate.id === id);
      expect(site, id).toBeDefined();
      if (!site) throw new Error(`Missing runtime health-field row ${id}`);
      if (!site.onRail) expect(live.rows.find((row: { id: string }) => row.id === id)?.disposition)
        .toEqual({ disposition: 'migrate', item: 'P-014' });
    }
  }, 120_000);

  const row = { id: 'owner-only-alarm|x.ts|check|1', disposition: 'migrate', item: 'P-007', route: 'condition' };
  const fixture = { rows: [row], amendments: [] };
  const live = { sites: [{ id: row.id, onRail: false }], rows: [{ id: row.id, disposition: { disposition: 'migrate', item: 'P-007' } }] };

  it('fails deletion, unreviewed relabelling, and an unfinished completed migration', () => {
    expect(manifestProblems(fixture, { sites: [], rows: [] }).join()).toMatch(/absent/);
    expect(manifestProblems(fixture, { ...live, rows: [{ id: row.id, disposition: { disposition: 'not-applicable', reason: 'silently waived' } }] }).join()).toMatch(/changed without amendment/);
    expect(manifestProblems(fixture, live, { completedItems: ['P-007'] }).join()).toMatch(/still bypasses/);
    expect(manifestProblems(fixture, live, { requireAllMigrated: true }).join()).toMatch(/still bypasses/);
  });

  it('requires an independent reviewed amendment and refuses amendments to unknown IDs', () => {
    const amendment = { rowId: row.id, change: { disposition: 'removed' }, reason: 'Reviewed removal of retired code', author: 'su-author', reviewerRef: 'thread-post:123' };
    expect(manifestProblems({ rows: [row], amendments: [amendment] }, { sites: [], rows: [] })).toEqual([]);
    for (const change of [{ reason: '' }, { reviewerRef: '' }, { reviewerRef: 'su-author' }, { rowId: 'unknown' }]) {
      expect(manifestProblems({ rows: [row], amendments: [{ ...amendment, ...change }] }, live).length).toBeGreaterThan(0);
    }
  });

  it('final acceptance cannot pass on an empty completion list or unreadable source', () => {
    const current = { ...live, unreadable: 0, undispositioned: 0, staleDispositions: [] };
    // Incremental guards permit work in progress; final acceptance always quantifies
    // over all seed migrate rows, regardless of the completion registry's contents.
    expect(manifestProblems(fixture, current, { completedItems: [] })).toEqual([]);
    expect(acceptanceProblems(fixture, current, [], []).join()).toMatch(/still bypasses/);
    const migrated = { ...current, sites: [{ id: row.id, onRail: true }], rows: [] };
    expect(acceptanceProblems(fixture, migrated, [], []).join()).toMatch(/has no case/);
    const testCase = { id: 'caller', item: row.item, route: row.route, rowIds: [row.id], run: () => ({}) };
    expect(acceptanceProblems(fixture, migrated, [testCase], [])).toEqual([]);
    expect(acceptanceProblems(fixture, { ...migrated, unreadable: 1 }, [testCase], []).join()).toMatch(/unreadable/);
    expect(acceptanceProblems(fixture, { ...migrated, staleDispositions: ['dead'] }, [testCase], []).join()).toMatch(/stale disposition/);
  });

  it('requires coverage for a reviewed amendment moving a migration to a different item', () => {
    const amended = { rows: [row], amendments: [{
      rowId: row.id, change: { disposition: 'migrate', item: 'P-014' },
      reason: 'Independent review assigns this detector to its actual migration lane',
      author: 'su-author', reviewerRef: 'thread-post:124',
    }] };
    const migrated = { sites: [{ id: row.id, onRail: true }], rows: [],
      unreadable: 0, undispositioned: 0, staleDispositions: [] };
    expect(acceptanceProblems(amended, migrated, [], []).join()).toMatch(/has no case/);
    const testCase = { id: 'detector', item: 'P-014', route: row.route,
      rowIds: [row.id], run: () => ({}) };
    expect(acceptanceProblems(amended, migrated, [testCase], [])).toEqual([]);
  });
});

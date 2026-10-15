import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import type { DreamRun } from './dream-run-store';
import { buildCalibrationBundle, calibrationStudyScope, calibrationKeyPublication } from './study/calibration.mts';
import { createHash } from 'node:crypto';
import { findBoxIdentityPaths } from '../../../../scripts/lib/identity-leak-patterns.mjs';
import { freezeImmutableArtifacts } from './study/freeze-artifacts.mts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runs() {
  const f = await createDreamCapabilityFixture('ws', 'pot');
  roots.push(f.root);
  return Array.from({ length: 10 }, (_, i) => ({
    workspaceId: 'ws',
    potSlug: 'pot',
    runId: 'private-run-' + i,
    status: 'rejected',
    costUsd: 0.2,
    review: { ...f.review, verdict: 'unverified', reason: i < 5 ? 'counterfactual-unknown' : 'review-unavailable' },
    outcome: {
      insight: f.insight,
      capabilityRun: {
        ...f.provenance,
        evaluation: { protocolPin: 'a'.repeat(64), arm: 'structured-pair', matchedPairIndex: i },
      },
    },
  })) as unknown as DreamRun[];
}

describe('frozen study calibration evidence preparation', () => {
  it('requires exact private custody before freezing a separate publication view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calibration-publication-'));
    roots.push(root);
    const machinePath = ['', 'home', 'private-study-account', 'source', 'worker.ts'].join('/');
    const key = { blindHash: 'b'.repeat(64), selected: [{ runId: 'frozen-run', graphTreatment: 'control',
      diagnostic: JSON.stringify({ path: machinePath }) }] };
    const original = JSON.stringify(key, null, 2) + '\n';
    const reportId = 'rpt_12345678-1234-4234-8234-123456789abc';
    const report = { report_id: reportId, path: '/reports?sel=' + reportId, visibility: 'owner',
      body_md: 'Original evidence.\n\n```json\n' + original + '```\n' };
    const bytes = calibrationKeyPublication(original, report);
    const published = JSON.parse(bytes);
    expect(findBoxIdentityPaths(bytes)).toEqual([]);
    expect(published.selected[0]).toMatchObject({ runId: 'frozen-run', graphTreatment: 'control' });
    expect(published.publication).toMatchObject({ originalBytes: Buffer.byteLength(original),
      originalSha256: createHash('sha256').update(original).digest('hex'), custody: { reportId, visibility: 'owner' } });
    expect(JSON.parse(published.selected[0].diagnostic).path).not.toBe(machinePath);
    expect(JSON.stringify(key, null, 2) + '\n').toBe(original);
    for (const invalid of [{ ...report, visibility: 'workspace' },
      { ...report, body_md: report.body_md.replace('frozen-run', 'other-run') },
      { ...report, path: '/reports?sel=rpt_other' }])
      expect(() => calibrationKeyPublication(original, invalid)).toThrow('exact owner-only custody');
    const originalPath = join(root, 'key.json');
    const publicPath = join(root, 'key-public.json');
    await freezeImmutableArtifacts([{ path: originalPath, bytes: original }]);
    await freezeImmutableArtifacts([{ path: publicPath, bytes }]);
    expect(await readFile(originalPath, 'utf8')).toBe(original);
    await expect(freezeImmutableArtifacts([{ path: publicPath, bytes: bytes + ' ' }])).rejects.toThrow('changed');
    expect(await readFile(publicPath, 'utf8')).toBe(bytes);
  });
  it('isolates the exact native comparison without overwriting legacy calibration editions', () => {
    const load = (file: string) => JSON.parse(readFileSync(new URL('./study/' + file, import.meta.url), 'utf8'));
    const blocks = [load('protocol.json'), load('protocol-luna.json')];
    const comparison = load('native-graph-protocol.json');
    expect(calibrationStudyScope(blocks)).toEqual({ pins: blocks.map(block => block.pin), prefix: '' });
    expect(calibrationStudyScope(blocks, comparison)).toEqual({ pins: [comparison.pin], prefix: 'native-graph-' });
    expect(() => calibrationStudyScope(blocks, { ...comparison, pin: 'a'.repeat(64) })).toThrow();
    expect(() => calibrationStudyScope(blocks, blocks[0])).toThrow('registered graph/control');
  });
  it('keeps graph treatment identity only in the unblinded key', async () => {
    const rows = await runs();
    const provenance = rows[0]!.outcome!.capabilityRun as Record<string, any>;
    provenance.evaluation.graphTreatment = 'control';
    const { blind, key } = buildCalibrationBundle([rows[0]!]);
    expect(key.selected[0]).toMatchObject({ graphTreatment: 'control' });
    expect(JSON.stringify(blind)).not.toContain('graphTreatment');
    expect(JSON.stringify(blind)).not.toContain(rows[0]!.runId);
  });
  it('does not leak metadata through production-shaped truncated narrative priors or their locators', async () => {
    const rows = await runs();
    rows[0]!.review!.priorMatches = [
      {
        ref: 'dream:private-run-2',
        kind: 'rejected-attempt',
        text: '{"status":"rejected","outcome":{"usage":{"model":"secret-model"},"protocolPin":"private-pin"'.padEnd(
          12_000,
          'x',
        ),
        contentHash: 'stored-hash',
        sourceHash: 'full-hash',
        locator: { kind: 'dream', id: 'private-run-2' },
      },
      {
        ref: 'idea:private-run-3',
        kind: 'idea',
        text: '{"humanGrade":"reject","routedRef":"private-run-4"}',
        contentHash: 'idea-hash',
      },
      { ref: 'plan:private-run-5', kind: 'plan', text: 'Review result private-verdict', contentHash: 'plan-hash' },
      {
        ref: 'code:private-run-6',
        kind: 'implementation',
        text: 'function current() {}',
        contentHash: 'code-hash',
        sourceHash: 'source-hash',
      },
    ];
    const { blind, key } = buildCalibrationBundle([rows[0]!]);
    const wire = JSON.stringify(blind);
    for (const forbidden of [
      'secret-model',
      'private-run-',
      'private-verdict',
      'private-pin',
      'rejected-attempt',
      'humanGrade',
    ])
      expect(wire).not.toContain(forbidden);
    expect(blind.cases[0]!.priors.slice(0, 3).every((p) => p.text === null && p.kind === 'prior-context')).toBe(true);
    expect(blind.cases[0]!.priors[3]).toMatchObject({
      ref: 'prior:4',
      kind: 'implementation',
      text: 'function current() {}',
    });
    expect(key.selected[0]!.priorRefMapping[0]).toMatchObject({
      blindRef: 'prior:1',
      originalRef: 'dream:private-run-2',
    });
    expect(key.selected[0]!.originalReview).not.toBe(rows[0]!.review);
    const originalReview = key.selected[0]!.originalReview as {
      priorMatches: Array<{
        capture: {
          format: string;
          parseStatus: string;
          truncated: boolean;
          storedChars: number | null;
          maxStoredChars: number;
          contentHash: string | null;
          sourceHash: string | null;
          fullTextRef: unknown;
        };
      }>;
    };
    expect(originalReview.priorMatches[0]).toMatchObject({
      ref: 'dream:private-run-2',
      capture: {
        format: 'json',
        parseStatus: 'truncated',
        truncated: true,
        storedChars: 12_000,
        maxStoredChars: 12_000,
        contentHash: 'stored-hash',
        sourceHash: 'full-hash',
        fullTextRef: {
          resolver: 'capability-review-sources.readCurrent',
          ref: 'dream:private-run-2',
          locator: { kind: 'dream', id: 'private-run-2' },
        },
      },
    });
    expect(originalReview.priorMatches[1]!.capture).toMatchObject({
      format: 'json',
      parseStatus: 'parseable',
      truncated: false,
      fullTextRef: null,
    });
    const roundTrip = JSON.parse(JSON.stringify(key)) as typeof key;
    const roundTripReview = roundTrip.selected[0]!.originalReview as typeof originalReview;
    for (const prior of roundTripReview.priorMatches) {
      if (prior.capture.format !== 'json') continue;
      expect(['parseable', 'truncated']).toContain(prior.capture.parseStatus);
      if (prior.capture.parseStatus === 'truncated')
        expect(prior.capture.fullTextRef).toMatchObject({ resolver: 'capability-review-sources.readCurrent' });
    }
  });
  it('retains bounded JSON code priors as incomplete even though their source hash identifies raw file bytes', async () => {
    const rows = await runs();
    const prefix = JSON.stringify({ path: 'large.test.ts', source: 'source'.repeat(4000) }).slice(0, 12000);
    rows[0]!.review!.priorMatches = [{ ref: 'code-source:large.test.ts', kind: 'test', text: prefix,
      contentHash: 'captured-envelope-hash', sourceHash: 'raw-file-hash',
      locator: { kind: 'code', id: 'source:large.test.ts', path: 'large.test.ts' } }];
    const bundle = buildCalibrationBundle([rows[0]!]);
    const capture = (bundle.key.selected[0]!.originalReview!.priorMatches as any[])[0].capture;
    expect(capture).toMatchObject({ parseStatus: 'truncated', truncated: true, storedChars: 12000,
      fullTextRef: { resolver: 'capability-review-sources.readCurrent', ref: 'code-source:large.test.ts',
        locator: { kind: 'code', id: 'source:large.test.ts' } } });
    expect((bundle.key.selected[0]!.originalReview!.priorMatches as any[])[0].text).toBe(prefix);
    rows[0]!.review!.priorMatches = [{ ref: 'code-source:large.test.ts', kind: 'test', text: prefix,
      contentHash: 'captured-envelope-hash', sourceHash: 'raw-file-hash' }];
    expect(() => buildCalibrationBundle([rows[0]!])).toThrow('no resolvable full-text reference');
  });
  it('refuses an unparseable JSON prior without proven truncation and a resolver', async () => {
    const rows = await runs();
    rows[0]!.review!.priorMatches = [
      {
        ref: 'dream:short-broken',
        kind: 'rejected-attempt',
        text: '{"broken":',
        contentHash: 'same-hash',
        sourceHash: 'same-hash',
        locator: { kind: 'dream', id: 'short-broken' },
      },
    ];
    expect(() => buildCalibrationBundle([rows[0]!])).toThrow('is not marked truncated');
  });
  it('is deterministic across row order, covers strata, and keeps identity/verdicts out of the blind envelope', async () => {
    const rows = await runs();
    const first = buildCalibrationBundle(rows);
    expect(buildCalibrationBundle([...rows].reverse())).toEqual(first);
    expect(first.blind.cases).toHaveLength(6);
    expect(new Set(first.key.selected.map((e) => e.stratum)).size).toBe(2);
    expect(first.key.unsampled).toHaveLength(4);
    const wire = JSON.stringify(first.blind);
    for (const forbidden of [
      'private-run-',
      'structured-pair',
      'counterfactual-unknown',
      'review-unavailable',
      'protocolPin',
      'originalReview',
    ])
      expect(wire).not.toContain(forbidden);
    expect(first.key.independentLabels).toBeNull();
    expect(first.key.qualifiedFamilies).toBeNull();
    expect(first.key.flatFaceted.every((e) => e.judgment === null)).toBe(true);
  });
  it('preserves all source claims and evidence when removing facet headings', async () => {
    const { blind, flatBlind, key } = buildCalibrationBundle(await runs(), 2);
    expect(flatBlind.sourceBlindHash).toBe(key.blindHash);
    expect(flatBlind.cases).toEqual(key.flatFaceted.map((entry) => entry.flattened));
    expect(flatBlind.instructions.join(' ')).toContain(
      'Freeze all six judgments before reading any faceted representation',
    );
    for (const [i, entry] of key.flatFaceted.entries()) {
      const original = blind.cases[i]!;
      const flattened = entry.flattened as unknown as {
        candidate: unknown;
        priors: unknown;
        units: Array<{
          sources: unknown;
          unit: {
            contracts: unknown;
            summaryClaims: unknown[];
            purpose?: never;
            mechanism?: never;
            evaluation?: never;
          };
        }>;
      };
      expect(flattened.candidate).toEqual(original.candidate);
      expect(flattened.priors).toEqual(original.priors);
      flattened.units.forEach((unit, j) => {
        const before = original.units[j]!;
        expect(unit.sources).toEqual(before.sources);
        expect(unit.unit.summaryClaims).toEqual([
          ...before.unit.purpose,
          ...before.unit.mechanism,
          ...before.unit.evaluation,
        ]);
        expect(unit.unit.contracts).toEqual(before.unit.contracts);
        expect(unit.unit).not.toHaveProperty('purpose');
        expect(unit.unit).not.toHaveProperty('mechanism');
        expect(unit.unit).not.toHaveProperty('evaluation');
      });
      expect(entry.facetedHash).not.toBe(entry.flatHash);
    }
  });
  it('validates every existing target before creating any missing immutable artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dream-calibration-freeze-'));
    roots.push(root);
    const first = join(root, 'first.json');
    const later = join(root, 'later.json');
    await writeFile(later, 'frozen\n');
    await expect(
      freezeImmutableArtifacts([
        { path: first, bytes: 'new\n', label: 'first.json' },
        { path: later, bytes: 'changed\n', label: 'later.json' },
      ]),
    ).rejects.toThrow('Frozen calibration batch changed: later.json');
    await expect(readFile(first, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(later, 'utf8')).toBe('frozen\n');
  });
  it('refuses duplicate, running or unbound rows; records missing candidates without inventing a label', async () => {
    const rows = await runs();
    expect(() => buildCalibrationBundle([rows[0]!, rows[0]!])).toThrow('Duplicate');
    expect(() => buildCalibrationBundle([{ ...rows[0]!, status: 'running' }])).toThrow('still running');
    expect(() => buildCalibrationBundle([{ ...rows[0]!, outcome: null }])).toThrow('Missing frozen');
    rows[0]!.outcome = { ...rows[0]!.outcome, insight: null };
    const bundle = buildCalibrationBundle(rows);
    expect(bundle.key.eligibleCandidates).toBe(9);
    expect(bundle.key.excluded).toEqual([
      { runId: rows[0]!.runId, reason: 'No retained candidate and selected source packets' },
    ]);
  });
});

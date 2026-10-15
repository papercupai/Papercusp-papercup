/**
 * P-004 / R-3 (mdenseon-adoption-measurements-2026-10-01) protocol guard for
 * the COMPLETE production retrieval runner, against a migrated throwaway
 * PostgreSQL database: production Mem0Backend + HybridBackend, entity linking,
 * per-route floors, decay and scope isolation, bound through the candidate
 * storage seam exactly as an mDenseOn arm is.
 *
 * The embedder is SYNTHETIC (a topic one-hot), so this measures NOTHING about
 * any model — the report says so (`binding.syntheticEmbedder`). What it pins is
 * that each mechanism the real runs report on actually engages:
 *
 *  - decay: two pairs of documents with IDENTICAL vectors and no lexical overlap
 *    with their query differ only by their frozen age. Run 1 stamps the `a`
 *    documents young; run 2 swaps the ages. The young document must lead on
 *    every route in BOTH runs, and the pairs were inserted in opposite orders,
 *    so neither insertion order nor a tie-break can produce the result.
 *  - scope isolation: leak decoys are copies of the answer documents. The
 *    positive control finds them in their own scope, and no route surfaces one.
 *  - entities: verbatim writes reach the entity graph (census > 0).
 *  - candidate binding: honoured in the isolated schema, refused on
 *    harness_shared.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configureMemory, memoryHost, disposeMemoryClient, resolveMemoryVectorBinding,
  type ExtractionLlm, type MemoryHost,
} from '@papercusp/memory';
import type { CorpusEntry } from '@papercusp/memory/bench';

import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { BENCH_SCHEMA } from './bench-host';
import type { HeldoutQuery, Snapshot } from './candidate-hybrid-bench';
import { LEAK_PREFIX, ROUTES, runCompleteHybrid } from './complete-hybrid-bench';
import { candidateProfile } from './measurement-manifest';

const DIMS = 768;
/** Paraphrase pairs share a dimension, so a query matches its targets by
 *  vector alone while sharing no token with them (the lexical leg is silent). */
const TOPIC: Record<string, number> = { zephyr: 0, breeze: 0, quasar: 1, pulsar: 1, harbor: 2, dockside: 2, violet: 3 };
/** A weak pull toward the violet distractor: a near-miss negative (cosine
 *  0.2/√1.04 ≈ 0.196) that only a floor can reject. */
const WEAK: Record<string, number> = { faintly: 3 };

async function topicEmbed(text: string): Promise<number[]> {
  const v = new Array<number>(DIMS).fill(0);
  let topical = false;
  for (const token of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const dim = TOPIC[token];
    if (dim !== undefined) { v[dim] += 1; topical = true; }
    if (WEAK[token] !== undefined) v[WEAK[token]] += 0.2;
  }
  // Off-topic text (negatives, entity names, the preflight probe): a stable
  // direction orthogonal to every topic dimension.
  if (!topical) v[400 + (createHash('sha256').update(text).digest()[0] % 300)] = 1;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

const verbatimOnlyExtractionLlm: ExtractionLlm = {
  async generateResponse() { throw new Error('complete-hybrid verbatim seed unexpectedly invoked fact extraction'); },
  async generateChat() { throw new Error('complete-hybrid verbatim seed unexpectedly invoked extraction chat'); },
};

const fact = (key: string, text: string): CorpusEntry => ({ key, text, kind: 'fact', metadata: { cluster: key } });
// Zephyr pair inserted a-then-b; quasar pair inserted b-then-a.
const ENTRIES: CorpusEntry[] = [
  fact('memory:zephyr-a', 'Zephyr alpha ledger entry recorded by Marisol Quentin in Lisbon.'),
  fact('memory:zephyr-b', 'Zephyr omega ledger entry recorded by Marisol Quentin in Lisbon.'),
  fact('memory:quasar-b', 'Quasar omega survey logged by Orlando Pierce at Kitt Peak.'),
  fact('memory:quasar-a', 'Quasar alpha survey logged by Orlando Pierce at Kitt Peak.'),
  fact('memory:harbor', 'Harbor crane maintenance schedule kept by Thaddeus Okafor.'),
  fact('memory:violet', 'Violet glass catalogue curated by Ingrid Vasquez.'),
];
const q = (id: string, cls: string, query: string, expected: string[], partition: HeldoutQuery['partition'], group: string): HeldoutQuery =>
  ({ id, class: cls, query, expected, partition, group });
const QUERIES: HeldoutQuery[] = [
  q('cal-pos', 'paraphrase', 'dockside lifting gear', ['memory:harbor'], 'calibration', 'harbor'),
  q('cal-neg', 'hard-negative', 'faintly sourdough fermentation timing', [], 'calibration', 'neg-cal'),
  q('t-zephyr', 'paraphrase', 'gentle breeze', ['memory:zephyr-a', 'memory:zephyr-b'], 'test', 'zephyr'),
  q('t-quasar', 'paraphrase', 'distant pulsar', ['memory:quasar-a', 'memory:quasar-b'], 'test', 'quasar'),
  q('t-neg', 'hard-negative', 'faintly medieval tapestry restoration', [], 'test', 'neg-test'),
];
const SNAPSHOT_AT = '2026-10-01T00:00:00.000Z';

type Report = Awaited<ReturnType<typeof runCompleteHybrid>>;

describe('complete-hybrid-bench drives the production memory path in an isolated schema (real PG)', () => {
  let db: OrgTestDb;
  let root: string;
  let originalHost: MemoryHost;
  const priorDecay = process.env.PAPERCUSP_MEMORY_DECAY;
  const reports: Record<'aYoung' | 'bYoung', Report> = {} as never;

  const writeJson = (name: string, value: unknown) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const ages = (young: 'a' | 'b') => Object.fromEntries(['zephyr', 'quasar'].flatMap((t) =>
    (['a', 'b'] as const).map((s) => [`memory:${t}-${s}`, s === young ? 0 : 400])));

  beforeAll(async () => {
    delete process.env.PAPERCUSP_MEMORY_DECAY; // decay ON, as in production
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-hybrid-'));
    db = await createOrgTestDb();
    originalHost = memoryHost();
    // All memory SQL goes to the migrated throwaway DB; the runner layers its
    // bench schema + arm embedder on top of this host.
    configureMemory({ ...originalHost, getAdminUrl: () => db.adminDsn, getExtractionLlm: async () => verbatimOnlyExtractionLlm });
    const snapshot: Snapshot = { formatVersion: 1, snapshotAt: SNAPSHOT_AT, seed: 'complete-hybrid-it',
      suites: { memory: { entries: ENTRIES }, prose: { entries: ENTRIES } } };
    const snapshotFile = writeJson('snapshot.json', snapshot);
    const goldFile = writeJson('gold.json', { memory: QUERIES, prose: QUERIES });
    for (const young of ['a', 'b'] as const) {
      const agesFile = writeJson(`ages-${young}.json`, { snapshotAt: SNAPSHOT_AT, ages: ages(young) });
      reports[young === 'a' ? 'aYoung' : 'bYoung'] = await runCompleteHybrid({
        snapshot: snapshotFile, gold: goldFile, model: 'mdenseon', corpus: 'memory', ages: agesFile,
        out: path.join(root, `report-${young}.json`), embed: topicEmbed,
      });
    }
  }, 240_000);

  afterAll(async () => {
    await disposeMemoryClient().catch(() => {});
    if (originalHost) configureMemory(originalHost);
    if (priorDecay === undefined) delete process.env.PAPERCUSP_MEMORY_DECAY;
    else process.env.PAPERCUSP_MEMORY_DECAY = priorDecay;
    await db?.cleanup();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('binds the candidate profile only inside its own bench schema and labels the embedder synthetic', () => {
    const { binding } = reports.aYoung;
    expect(binding.schema).toBe(BENCH_SCHEMA);
    expect(binding.schema).toMatch(/^bench_memory_/);
    expect(binding).toMatchObject({ mode: 'gemma', table: 'memory_vec_gemma', profileId: candidateProfile('mdenseon').profileId,
      syntheticEmbedder: true,
      candidateStorage: { schema: BENCH_SCHEMA, acceptedProfileIds: { gemma: [candidateProfile('mdenseon').profileId] } } });
  });

  it('seeds every document plus its leak decoys, links entities, and stamps every frozen age', () => {
    for (const report of Object.values(reports)) {
      expect(report.seed.documents).toBe(ENTRIES.length);
      expect(report.seed.leakDecoys).toBe(4);
      expect(report.seed.memories).toBe(ENTRIES.length + 4);
      expect(report.seed.entities).toBeGreaterThan(0);
      expect(report.seed.agedRows).toBe(4);
    }
  });

  it('isolates the leak scope: the positive control finds the decoys, no route ever surfaces one', () => {
    for (const report of Object.values(reports)) {
      expect(report.guards.scopeIsolation.positiveControlHits).toBeGreaterThan(0);
      expect(report.guards.scopeIsolation.leakedHits).toBe(0);
      for (const row of report.rows) {
        for (const route of ROUTES) expect(row.routes[route]!.rankedKeys.some((k) => k.startsWith(LEAK_PREFIX))).toBe(false);
      }
    }
  });

  it('decay orders equal-vector documents by frozen age on every route, and swapping the ages flips the order', () => {
    const order = (report: Report, id: string, route: (typeof ROUTES)[number]) => {
      const keys = report.rows.find((r) => r.id === id)!.routes[route]!.rankedKeys;
      return keys.filter((k) => /-(a|b)$/.test(k));
    };
    for (const route of ROUTES) {
      expect(order(reports.aYoung, 't-zephyr', route), route).toEqual(['memory:zephyr-a', 'memory:zephyr-b']);
      expect(order(reports.aYoung, 't-quasar', route), route).toEqual(['memory:quasar-a', 'memory:quasar-b']);
      expect(order(reports.bYoung, 't-zephyr', route), route).toEqual(['memory:zephyr-b', 'memory:zephyr-a']);
      expect(order(reports.bYoung, 't-quasar', route), route).toEqual(['memory:quasar-b', 'memory:quasar-a']);
    }
  });

  it('scores positives and negatives per route through the calibrated floor', () => {
    const { summary, calibration } = reports.aYoung;
    expect(calibration.queries).toBe(2);
    for (const route of ROUTES) expect(summary[route]).toMatchObject({ positives: 2, negatives: 1, recallAt10: 1, mrr: 1 });
    // A near-miss negative (cosine ≈ 0.196 to the violet distractor): the calibration negative
    // sits at the same cosine, so this arm's floor lands just above it. The shipped push floor
    // and the calibrated floor reject it; the unfloored route admits it (the positive control
    // that the rejections above are the floors' doing, not an empty store).
    expect(calibration.calibratedCosineFloor).toBeGreaterThan(0.19);
    expect(calibration.calibratedCosineFloor).toBeLessThan(1);
    expect(summary.push.negativeAdmission).toBe(0);
    expect(summary['push-calibrated'].negativeAdmission).toBe(0);
    expect(summary.raw.negativeAdmission).toBe(1);
  });

  it('refuses the same candidate acceptance on the shared production schema', async () => {
    const profile = candidateProfile('mdenseon');
    const resolved = { mode: 'gemma', dims: DIMS, profile, embed: topicEmbed } as const;
    const host = memoryHost();
    try {
      configureMemory({ ...host, schema: 'harness_shared',
        candidateStorage: { schema: 'harness_shared', acceptedProfileIds: { gemma: [profile.profileId] } } });
      const { binding, problems } = resolveMemoryVectorBinding(resolved);
      expect(binding).toBeUndefined();
      expect(problems.join('\n')).toContain('refused on shared schema harness_shared');
    } finally {
      configureMemory(host);
    }
  });
});

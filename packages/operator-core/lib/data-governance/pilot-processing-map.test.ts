/**
 * Pins the pilot processing map (P-007a, WI-6554700010011592) to the code and the contract.
 * A renamed or deleted seat, a store a seat no longer touches, a contract row with no path, or
 * a path whose unknowns were silently emptied all fail here.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_DATA_CLASSES,
  HOSTED_CUSTOMER_DATA_TABLES,
  isCustomerDataClass,
  qualifiedName,
} from '../auth/hosted/customer-data-map';
import {
  PILOT_CONTRACT_ROWS,
  PILOT_PROCESSING_MAP,
  pilotPathDataClasses,
  pilotStorePopulation,
} from './pilot-processing-map';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTRACT_DOC = 'docs/evidence/enterprise-pilot-contract-draft-2026-10-11.md';

const sourceCache = new Map<string, string>();
function source(rel: string): string {
  let text = sourceCache.get(rel);
  if (text === undefined) {
    text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    sourceCache.set(rel, text);
  }
  return text;
}

function exportsSymbol(text: string, symbol: string): boolean {
  const declared = new RegExp(
    `^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|class|interface|type|enum)\\s+${symbol}\\b`,
    'm',
  );
  const listed = new RegExp(`^export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`, 'm');
  return declared.test(text) || listed.test(text);
}

/** First-column cells of the contract's "Processing path" table. */
function contractTableRows(): string[] {
  const lines = source(CONTRACT_DOC).split('\n');
  const header = lines.findIndex((l) => /^\|\s*Processing path\s*\|/.test(l));
  expect(header, 'contract processing table header').toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|')[1]!.trim());
  }
  return rows;
}

describe('pilot processing map', () => {
  it('declares exactly the rows of the pilot contract processing table', () => {
    expect(contractTableRows()).toEqual([...PILOT_CONTRACT_ROWS]);
  });

  it('covers every contract row with at least one in-profile path', () => {
    for (const row of PILOT_CONTRACT_ROWS) {
      const covering = PILOT_PROCESSING_MAP.filter(
        (p) => p.status !== 'outside-profile' && p.contractRows.includes(row),
      );
      expect(covering.map((p) => p.id), row).not.toEqual([]);
    }
  });

  it('has unique path ids', () => {
    const ids = PILOT_PROCESSING_MAP.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cites only files that exist and export the named symbol', () => {
    const broken: string[] = [];
    for (const p of PILOT_PROCESSING_MAP) {
      expect(p.enforcement.length, `${p.id} enforcement`).toBeGreaterThan(0);
      for (const e of p.enforcement) {
        const abs = path.join(REPO_ROOT, e.file);
        if (!existsSync(abs)) broken.push(`${p.id}: missing file ${e.file}`);
        else if (!exportsSymbol(source(e.file), e.exportedSymbol)) {
          broken.push(`${p.id}: ${e.file} does not export ${e.exportedSymbol}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('names only stores that one of the path\'s cited seats touches', () => {
    const unpinned: string[] = [];
    for (const p of PILOT_PROCESSING_MAP) {
      const files = [...new Set(p.enforcement.map((e) => e.file))].filter((f) =>
        existsSync(path.join(REPO_ROOT, f)),
      );
      for (const store of p.stores) {
        if (!files.some((f) => source(f).includes(store.qualified))) {
          unpinned.push(`${p.id}: ${store.qualified}`);
        }
      }
    }
    expect(unpinned).toEqual([]);
  });

  it('declares one retention treatment for each persisted store across its processing paths', () => {
    const treatments = new Map<string, Set<string>>();
    for (const p of PILOT_PROCESSING_MAP.filter((p) => p.status !== 'outside-profile')) {
      for (const store of p.stores) {
        const declared = treatments.get(store.qualified) ?? new Set<string>();
        declared.add(store.retention);
        treatments.set(store.qualified, declared);
      }
    }
    const conflicting = [...treatments]
      .filter(([, declared]) => declared.size !== 1)
      .map(([qualified, declared]) => ({ qualified, retention: [...declared].sort() }));
    expect(conflicting).toEqual([]);
    for (const store of pilotStorePopulation()) {
      const declared = treatments.get(store.qualified);
      if (declared) expect(declared.has(store.retention), store.qualified).toBe(true);
    }
  });

  it('makes unknowns explicit: never empty, and "none" only on a selected path', () => {
    for (const p of PILOT_PROCESSING_MAP) {
      expect(p.unknowns.length, `${p.id} unknowns`).toBeGreaterThan(0);
      const saysNone = p.unknowns.length === 1 && p.unknowns[0] === 'none';
      if (saysNone) expect(p.status, `${p.id} claims nothing unknown`).toBe('selected');
      if (p.status === 'unknown' || p.status === 'outside-profile') expect(saysNone).toBe(false);
      for (const u of p.unknowns) expect(u.trim(), `${p.id} blank unknown`).not.toBe('');
    }
  });

  it('keeps cross-item acceptance in its owning ledger instead of copying lifecycle status', () => {
    // A processing declaration is consumed by security/procurement evidence. A copied
    // "not built"/"done" status silently contradicts the independently updated item.
    // Keep stable ownership/qualification references here and resolve status at use.
    const copiedStatus = PILOT_PROCESSING_MAP.flatMap((p) =>
      p.unknowns
        .filter((u) => /\b(?:P-\d{3,}|WI-\d+)\b/.test(u))
        .filter((u) => /\b(?:not built(?: yet)?|completed|shipped|done)\b/i.test(u))
        .map((u) => `${p.id}: ${u}`),
    );
    expect(copiedStatus).toEqual([]);
  });

  // P-007b (WI-6554700010011594) / WI-6554700010011737: a selected path must name the tests that
  // exercise its permitted and denied journeys, and those tests must exist. A path that is not
  // selected names none, so a canary can never be claimed for a path the pilot does not run.
  it('names existing canary journey tests on every selected path, and none elsewhere', () => {
    for (const p of PILOT_PROCESSING_MAP) {
      if (p.status === 'selected') {
        expect(p.canaryJourney, p.id).not.toBeNull();
        expect(p.canaryJourney!.length, p.id).toBeGreaterThan(0);
        for (const rel of p.canaryJourney!) {
          expect(rel, `${p.id}: ${rel}`).toMatch(/\.test\.ts$/);
          expect(existsSync(path.join(REPO_ROOT, rel)), `${p.id}: ${rel}`).toBe(true);
        }
      } else {
        expect(p.canaryJourney, p.id).toBeNull();
      }
    }
  });

  // P-016a (WI-6554700010011918): every path answers the processing-location question. An
  // `enforced` path names seats it really cites and a canary that carries its marker; a selected
  // path may not be `not-assessed`; and at least one selected path enforces provider + region.
  it('declares processing restrictions on every path, pinned to real seats and canaries', () => {
    const marker = (id: string) => `processing-restriction-canary:${id}`;
    for (const p of PILOT_PROCESSING_MAP) {
      const r = p.restrictions;
      expect(r, `${p.id} has no restrictions`).toBeTruthy();
      if (r.kind === 'enforced') {
        expect(p.status, `${p.id}: only a selected path can enforce`).toBe('selected');
        expect(r.categories, `${p.id}`).toEqual(expect.arrayContaining(['providers', 'regions']));
        const cited = new Set(p.enforcement.map((e) => e.exportedSymbol));
        for (const seat of r.seats) expect(cited.has(seat), `${p.id}: seat ${seat} is not an enforcement point`).toBe(true);
        expect(r.seats.length, `${p.id}`).toBeGreaterThan(0);
        const canaries = (p.canaryJourney ?? []).filter((rel) => source(rel).includes(marker(p.id)));
        expect(canaries, `${p.id}: no canary carries ${marker(p.id)}`).not.toHaveLength(0);
      } else {
        expect(r.reason.trim().length, `${p.id}: empty reason`).toBeGreaterThan(20);
        if (r.kind === 'not-assessed') expect(p.status, `${p.id}: a selected path must be assessed`).not.toBe('selected');
      }
    }
    expect(PILOT_PROCESSING_MAP.some((p) => p.status === 'selected' && p.restrictions.kind === 'enforced')).toBe(true);
  });

  // P-016a DLP (WI-6554700010011918): every path names the customer data classes it moves, in the
  // one vocabulary the dataUse `class:<cls>` labels use. Export never releases secrets; a backup
  // carries every class, so restore and deletion reach all of them.
  it('declares the data classes every path moves, in the customer data-class vocabulary', () => {
    for (const p of PILOT_PROCESSING_MAP) {
      expect(p.dataClasses.length, `${p.id} declares no data classes`).toBeGreaterThan(0);
      expect(new Set(p.dataClasses).size, `${p.id} repeats a class`).toBe(p.dataClasses.length);
      for (const cls of p.dataClasses) expect(isCustomerDataClass(cls), `${p.id}: ${cls}`).toBe(true);
      expect(pilotPathDataClasses(p.id)).toEqual(p.dataClasses);
    }
    expect(pilotPathDataClasses('organization-export-and-deletion')).not.toContain('secret');
    expect([...pilotPathDataClasses('backups-and-restores')].sort()).toEqual([...CUSTOMER_DATA_CLASSES].sort());
    expect(() => pilotPathDataClasses('no-such-path')).toThrow(/no path 'no-such-path'/);
  });

  it('gives every pending path an owning work-item', () => {
    for (const p of PILOT_PROCESSING_MAP.filter((x) => x.status === 'pending')) {
      expect(p.ownerRef, p.id).toMatch(/^(WI|EI)-\d+$/);
    }
  });

  it('does not cite the deleted Slack organization connector (D-014)', () => {
    const cited = PILOT_PROCESSING_MAP.flatMap((p) => p.enforcement.map((e) => e.file));
    expect(cited.filter((f) => f.endsWith('slack-org-connector.ts'))).toEqual([]);
  });

  describe('pilotStorePopulation', () => {
    const population = pilotStorePopulation();

    it('lists each qualified store once', () => {
      const names = population.map((e) => e.qualified);
      expect(new Set(names).size).toBe(names.length);
    });

    it('includes every hosted customer-data table', () => {
      const names = new Set(population.map((e) => e.qualified));
      const missing = HOSTED_CUSTOMER_DATA_TABLES.map(qualifiedName).filter((n) => !names.has(n));
      expect(missing).toEqual([]);
    });

    it('includes every in-profile pilot store and no outside-profile-only store', () => {
      const names = new Set(population.map((e) => e.qualified));
      const inProfile = new Set(
        PILOT_PROCESSING_MAP.filter((p) => p.status !== 'outside-profile').flatMap((p) =>
          p.stores.map((s) => s.qualified),
        ),
      );
      for (const n of inProfile) expect(names.has(n), n).toBe(true);
      const outsideOnly = PILOT_PROCESSING_MAP.filter((p) => p.status === 'outside-profile')
        .flatMap((p) => p.stores.map((s) => s.qualified))
        .filter((n) => !inProfile.has(n) && !HOSTED_CUSTOMER_DATA_TABLES.map(qualifiedName).includes(n));
      for (const n of outsideOnly) expect(names.has(n), n).toBe(false);
    });

    it('marks pilot stores as pilot-map and the rest as hosted-map', () => {
      const pilot = population.filter((e) => e.source === 'pilot-map');
      expect(pilot.map((e) => e.qualified)).toContain('harness_shared.documents');
      expect(population.filter((e) => e.source === 'hosted-map').length).toBeGreaterThan(0);
    });
  });
});

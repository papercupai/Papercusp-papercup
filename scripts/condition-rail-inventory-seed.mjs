#!/usr/bin/env node
/** P-017: materialise the ORIGINAL audit once; refuse to overwrite its immutable row set. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runInventory } from './condition-rail-inventory.mjs';

const input = process.argv[2];
if (!input) throw new Error('Usage: node --import tsx scripts/condition-rail-inventory-seed.mjs <original-audit.json>');
const output = resolve('docs/evidence/condition-rail-inventory-seed-2026-10-11.json');
if (existsSync(output)) throw new Error('Seed already exists; use a reviewed amendment, never regenerate its rows.');
const bytes = readFileSync(input);
const original = JSON.parse(bytes.toString());
// The writer was added after P-001's audit; its own failure telemetry cannot recursively use it.
const seed = original.rows.filter((row) => row.file !== 'packages/operator-core/lib/degradation/fallback-observations.ts');
if (seed.length !== 307 || seed.filter((row) => row.disposition.disposition === 'migrate').length !== 243) {
  throw new Error('Input is not the original 307-row / 243-migration audit.');
}
const live = runInventory();
const used = new Set();
const rows = seed.map((row) => {
  const candidates = live.sites.filter((site) => site.class === row.class && site.file === row.file && site.symbol === row.symbol);
  let site = candidates.find((candidate) => candidate.line === row.line);
  if (!site) {
    // Measured source drift since the audit shifted four release-actions.ts sites. Use source
    // order only when the entire token group has unchanged cardinality; never pick nearest.
    const originalGroup = seed.filter((candidate) => candidate.class === row.class && candidate.file === row.file && candidate.symbol === row.symbol);
    if (originalGroup.length !== candidates.length) throw new Error(`Ambiguous seed site: ${row.class}|${row.file}:${row.line}`);
    site = candidates[originalGroup.indexOf(row)];
  }
  if (!site || used.has(site.id)) throw new Error(`Missing/duplicate seed site: ${row.class}|${row.file}:${row.line}`);
  used.add(site.id);
  const { disposition, item, reason } = row.disposition;
  return {
    id: site.id, class: row.class, file: row.file, enclosing: site.enclosing, ordinal: site.ordinal,
    line: row.line, symbol: row.symbol, disposition, ...(item ? { item } : {}), ...(reason ? { reason } : {}),
    route: row.class === 'log-only-fallback' || ['P-010', 'P-011', 'P-012', 'P-013', 'P-015'].includes(item) ? 'observation' : 'condition',
  };
});
const rowsSha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, plan: 'degradation-signals-on-condition-rail-2026-10-11',
  sourceAuditSha256: createHash('sha256').update(bytes).digest('hex'), rowsSha256, rows, amendments: [] }, null, 2)}\n`);
console.log(JSON.stringify({ output, rows: rows.length, rowsSha256 }));

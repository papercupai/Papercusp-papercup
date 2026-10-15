/** R-3 guards the pinned report artifact; it does not prove the underlying systems. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const artifact = JSON.parse(readFileSync(resolve(import.meta.dirname,
  '../../../../docs/evidence/dao-voting-p2p-security-census-2026-10-08.json'), 'utf8'));
// Independent population copied from the original P-001 census, not the report under test.
const population = [
  'Device identity, GitHub binding and session authentication',
  'Membership, private pots and scoped logs',
  'Read/write authorization and moderation',
  'Provenance, immutable identity, replay and conflicts',
  'Replication, restart, partitions and convergence',
  'Voting authority and authentication',
  'Voting tally, quorum, delegation, replacement, pause/revoke',
  'Exact approved action and one-way chain mirror',
  'Metering, payment reservation, batch settlement and escrow forks',
  'Offer authorship, grants, budgets and inference leases',
  'Delegated seats, foreign workspace execution and revocation',
  'Sandbox and artifact distribution',
  'Fleet leader leases, treasury and external execution',
];
const columns = ['Source feature', 'As-built guarantee and authority boundary', 'Exact proof/test evidence',
  'Trust assumptions', 'Enforcement after host compromise', 'Owned limitations and next verification'];

function census(body: string) {
  const section = body.split('## Complete feature matrix\n')[1]?.split('## Evidence identities')[0];
  expect(section, 'complete matrix section').toBeTruthy();
  const rows = section!.split('\n').filter(line => line.startsWith('| '))
    .map(line => line.trim().slice(1, -1).split(' | ').map(cell => cell.trim()));
  expect(rows.shift(), 'all authority/proof/trust/compromise/owner columns').toEqual(columns);
  return rows;
}

function verifyCensus(body: string) {
  const rows = census(body);
  expect(rows.map(row => row[0]), 'exact original population, once each').toEqual(population);
  for (const row of rows) {
    expect(row, row[0]).toHaveLength(columns.length);
    row.forEach((cell, index) => expect(cell.trim(), `${row[0]}: ${columns[index]}`).not.toBe(''));
    expect(row[2], `${row[0]}: exact evidence identity`).toMatch(/\bE[1-4]\b|\b(?:WI|EI)-\d+|\b\d{8}\b/);
    expect(row[5], `${row[0]}: accountable limitation`).toMatch(/\bWI-\d+/);
    for (const cell of row.slice(1)) {
      // Known dangerous positive claims must not hide behind a global disclaimer.
      expect(cell, `${row[0]}: overstated proof or host guarantee`).not.toMatch(
        /(?:is|establishes?|provides?|proves?|guarantees?) (?:an? )?(?:unbounded|unconditional|exhaustive|universal) (?:proof|guarantee|theorem)|all guarantees survive full host compromise/i);
    }
  }
  expect(body, 'implementation owner').toContain('su-6788d0ac-d425-4756-a9b3-3a451df401be');
  expect(body, 'full host-control threat').toContain('replace its verifier, database and logs');
  expect(body, 'signer compromise assumption').toContain('A host holding all relevant signing keys can forge those signers.');
  expect(body, 'key custody assumption').toContain('key custody');
  expect(body, 'independent enforcement requirement').toContain('Independent signer thresholds or independently enforced chain contracts');
  expect(body, 'bounded proof vocabulary').toContain('Neither is an unbounded proof of TypeScript, PostgreSQL, networking, cryptography, kernel isolation or external contracts.');
  expect(body, 'unknown remains unknown').toContain('UNKNOWN remains UNKNOWN.');
}

function replaceCell(body: string, rowIndex: number, column: number, value: string) {
  const row = census(body)[rowIndex]!;
  const original = '| ' + row.join(' | ') + ' |';
  const changed = [...row];
  changed[column] = value;
  expect(body).toContain(original);
  return body.replace(original, '| ' + changed.join(' | ') + ' |');
}

describe('AUTO-BAR-R-3-P-006@4 exact documentary security census', () => {
  it('pins the independently read report and original feature population', () => {
    expect(artifact.reportId).toBe('rpt_53a423e7-91de-492a-9b14-2c1fc690c217');
    expect(artifact.bodySha256).toBe('0942ef7219a0eed04d3c8ca04355c5b6287415561d6479b5042fc06e58e60d9a');
    expect(createHash('sha256').update(artifact.body_md).digest('hex')).toBe(artifact.bodySha256);
    expect(artifact.population).toEqual(population);
    verifyCensus(artifact.body_md);
  });

  it.each(population)('refuses a missing source feature: %s', feature => {
    const body = artifact.body_md.split('\n').filter((line: string) => !line.startsWith('| ' + feature + ' |')).join('\n');
    expect(() => verifyCensus(body)).toThrow();
  });

  it.each(columns.slice(1).map((name, index) => [name, index + 1] as const))('refuses an empty %s in every feature', (_name, column) => {
    for (let index = 0; index < population.length; index++)
      expect(() => verifyCensus(replaceCell(artifact.body_md, index, column, ''))).toThrow();
  });

  it('refuses duplicate feature identity, even when the row count is unchanged', () => {
    expect(() => verifyCensus(replaceCell(artifact.body_md, 1, 0, population[0]!))).toThrow();
  });

  it('refuses a limitation without an accountable work-item in every feature', () => {
    for (let index = 0; index < population.length; index++)
      expect(() => verifyCensus(replaceCell(artifact.body_md, index, 5, 'Someone should verify this later.'))).toThrow();
  });

  it('refuses generic evidence without an exact identity in every feature', () => {
    for (let index = 0; index < population.length; index++)
      expect(() => verifyCensus(replaceCell(artifact.body_md, index, 2, 'Tests passed.'))).toThrow();
  });

  it.each(['This is an unbounded proof of the deployed implementation.',
    'All guarantees survive full host compromise.'])('refuses an overstated guarantee: %s', claim => {
    expect(() => verifyCensus(replaceCell(artifact.body_md, 6, 1, claim))).toThrow();
  });

  it.each(['replace its verifier, database and logs', 'A host holding all relevant signing keys can forge those signers.',
    'Independent signer thresholds or independently enforced chain contracts', 'UNKNOWN remains UNKNOWN.'])('refuses omission of threat/proof boundary: %s', boundary => {
    expect(() => verifyCensus(artifact.body_md.replace(boundary, ''))).toThrow();
  });
});

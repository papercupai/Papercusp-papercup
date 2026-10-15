import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DATATYPE_MANIFEST,
  DATATYPE_PACKAGE_SCHEMA_VERSION,
  readDatatypeDir,
  writeDatatypePackageDir,
  type DatatypeExportSource,
} from './datatype-store';

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'datatype-store-'));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const SELF_IMPROVEMENT = {
  improvements: [{ id: 'calibrate', description: 'tighten the payload schema' }],
  scorecard: [{ metric: 'accuracy', description: 'share of settled rows that matched' }],
  gym: { signals: ['settled'], rubric: 'did the recorded odds beat the close?' },
};

const BET: DatatypeExportSource = {
  id: 'bet',
  title: 'Bet',
  description: 'a wager with odds, stake and a settlement outcome',
  tier: 'generic-kind',
  workItemKind: 'bet',
  payloadSchema: { type: 'object', properties: { stake: { type: 'number' } } },
  selfImprovement: SELF_IMPROVEMENT,
  tags: ['hive-placement'],
};

/** Write a package dir by hand so a test can express manifests the writer refuses. */
function handWritten(manifest: Record<string, unknown>, listing?: Record<string, unknown>): string {
  const dir = scratch();
  writeFileSync(join(dir, DATATYPE_MANIFEST), JSON.stringify(manifest), 'utf8');
  writeFileSync(
    join(dir, 'listing.json'),
    JSON.stringify(listing ?? { kind: 'datatype', ref: 'bet', source: 'https://github.com/o/r' }),
    'utf8',
  );
  return dir;
}

function goodManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DATATYPE_PACKAGE_SCHEMA_VERSION,
    id: 'bet',
    title: 'Bet',
    description: 'a wager with odds, stake and a settlement outcome',
    version: '0.1.0',
    tier: 'generic-kind',
    workItemKind: 'bet',
    selfImprovement: SELF_IMPROVEMENT,
    ...over,
  };
}

describe('datatype package round-trip', () => {
  it('writes a definition and reads back every field the registry row needs', () => {
    const written = writeDatatypePackageDir(BET, {
      source: 'https://github.com/papercup/datatypes',
      targetDir: scratch(),
    });
    const read = readDatatypeDir(written.dir, written.ref);
    expect(read).not.toBeNull();
    expect(read!.id).toBe('bet');
    expect(read!.tier).toBe('generic-kind');
    expect(read!.workItemKind).toBe('bet');
    expect(read!.payloadSchema).toEqual(BET.payloadSchema);
    expect(read!.selfImprovement).toEqual(SELF_IMPROVEMENT);
    expect(read!.tags).toEqual(['hive-placement']);
    expect(read!.source).toBe('https://github.com/papercup/datatypes');
    // The package-scoped identity is NOT the registry id — installing the same
    // definition twice must not claim to be the same registry row.
    expect(read!.installedId).toMatch(/^installed:[0-9a-f]{16}$/);
    expect(read!.installedId).not.toBe(read!.id);
  });

  it('is a distribution artifact only: a projection datatype needs no self-improvement surface', () => {
    // POSITIVE CONTROL for the two refusals below — without it, a validator that
    // rejected everything would produce the same all-green run.
    const written = writeDatatypePackageDir(
      {
        id: 'odds-line',
        title: 'Odds line',
        description: 'a read-only projection an external engine writes',
        tier: 'projection',
        authoritativeWriter: 'engine:oddsmith',
      },
      { source: 'https://github.com/papercup/datatypes', targetDir: scratch() },
    );
    const read = readDatatypeDir(written.dir, written.ref);
    expect(read).not.toBeNull();
    expect(read!.tier).toBe('projection');
    expect(read!.authoritativeWriter).toBe('engine:oddsmith');
    expect(read!.selfImprovement).toBeNull();
  });
});

describe('the declare-time gates survive the distribution boundary', () => {
  it('refuses a generic-kind package with no self-improvement surface (P-010)', () => {
    const dir = handWritten(goodManifest({ selfImprovement: undefined }));
    expect(readDatatypeDir(dir, 'bet')).toBeNull();
    expect(() =>
      writeDatatypePackageDir(
        { ...BET, selfImprovement: null },
        { source: 'https://github.com/o/r', targetDir: scratch() },
      ),
    ).toThrow(/self-improvement/i);
  });

  it('refuses a payloadSchema that does not compile (P-001)', () => {
    const dir = handWritten(goodManifest({ payloadSchema: { type: 'not-a-json-schema-type' } }));
    expect(readDatatypeDir(dir, 'bet')).toBeNull();
  });

  it('refuses an id that is not already the canonical registry slug', () => {
    // A package whose id re-slugifies would seed a row under a DIFFERENT id than
    // the package claims — the package and the registry must agree on identity.
    const dir = handWritten(goodManifest({ id: 'Calibration Record' }));
    expect(readDatatypeDir(dir, 'bet')).toBeNull();
    expect(() =>
      writeDatatypePackageDir({ ...BET, id: 'Calibration Record' }, {
        source: 'https://github.com/o/r',
        targetDir: scratch(),
      }),
    ).toThrow(/canonical kebab slug/);
  });

  it('refuses an unknown tier and a mismatched listing kind', () => {
    expect(readDatatypeDir(handWritten(goodManifest({ tier: 'first-classish' })), 'bet')).toBeNull();
    expect(
      readDatatypeDir(
        handWritten(goodManifest(), { kind: 'theme', ref: 'bet', source: 'https://github.com/o/r' }),
        'bet',
      ),
    ).toBeNull();
  });

  it('refuses a manifest from a future schema version', () => {
    expect(readDatatypeDir(handWritten(goodManifest({ schemaVersion: 2 })), 'bet')).toBeNull();
  });
});

describe('the datatype nature travels with the package (enterprise-data-sources P-008)', () => {
  it('round-trips a declared nature and audience through write + read', () => {
    const written = writeDatatypePackageDir(
      { ...BET, nature: 'record', audience: null },
      { source: 'https://github.com/papercup/datatypes', targetDir: scratch() },
    );
    const read = readDatatypeDir(written.dir, written.ref);
    expect(read).not.toBeNull();
    expect(read!.nature).toBe('record');
    expect(read!.audience).toBeNull();

    const work = readDatatypeDir(handWritten(goodManifest({ nature: 'work', audience: 'human' })), 'bet');
    expect(work).not.toBeNull();
    expect(work!.nature).toBe('work');
    expect(work!.audience).toBe('human');
  });

  it('reads a pre-nature package as nature null, so the installer applies the legacy rule', () => {
    const read = readDatatypeDir(handWritten(goodManifest()), 'bet');
    expect(read).not.toBeNull();
    expect(read!.nature).toBeNull();
    expect(read!.audience).toBeNull();
  });

  it('refuses an invalid nature, work with no audience, data with an audience, and an audience with no nature', () => {
    expect(readDatatypeDir(handWritten(goodManifest({ nature: 'data' })), 'bet')).toBeNull();
    expect(readDatatypeDir(handWritten(goodManifest({ nature: 'work' })), 'bet')).toBeNull();
    expect(readDatatypeDir(handWritten(goodManifest({ nature: 'record', audience: 'agent' })), 'bet')).toBeNull();
    expect(readDatatypeDir(handWritten(goodManifest({ audience: 'agent' })), 'bet')).toBeNull();
  });

  it('the writer refuses an invalid nature rather than shipping a package no installer can read', () => {
    expect(() =>
      writeDatatypePackageDir(
        { ...BET, nature: 'work', audience: null },
        { source: 'https://github.com/papercup/datatypes', targetDir: scratch() },
      ),
    ).toThrow(/invalid datatype nature/);
  });
});

/**
 * WI-10004651: content drift becomes alertable only once the known-drift set is
 * acknowledged. These pin (1) the acknowledgement contract — every entry says why —
 * (2) the "new drift" selection rule, and (3) the watchdog collector that files it.
 */
import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGED_CONTENT_DRIFT,
  selectNewContentDrift,
} from './migration-content-drift-acknowledged';
import { collectMigrationContentDriftSignals } from './harness/improvements/watchdog';
import { INFRA_SIGNAL_SOURCES } from './harness/improvements/policy';
import { DEFECT_SOURCES } from './harness/improvements/signal-lane';
import { AUTO_CLOSE_ELIGIBLE_SOURCES } from './harness/improvements/auto-close-sources';

const entry = (filename: string, classification: string) => ({
  filename,
  recordedSha256: 'a'.repeat(64),
  diskSha256: 'b'.repeat(64),
  classification,
  classificationDetail: 'fixture',
});

describe('ACKNOWLEDGED_CONTENT_DRIFT (WI-10004651)', () => {
  it('every acknowledged entry is a runner migration filename with a non-empty reason', () => {
    expect(ACKNOWLEDGED_CONTENT_DRIFT.size).toBeGreaterThan(0);
    for (const [filename, reason] of ACKNOWLEDGED_CONTENT_DRIFT) {
      expect(filename).toMatch(/^\d{3,4}-[a-z0-9-]+\.sql$/);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('1219 is acknowledged only because 1288 repaired it, and the reason says so', () => {
    expect(ACKNOWLEDGED_CONTENT_DRIFT.get('1219-blueprint-operation-invocations.sql')).toMatch(
      /repaired by 1288-/,
    );
  });

  it('1398 is acknowledged because its executable SQL matches the applied blob', () => {
    const filename = '1398-retire-probation-freshness-readiness-reasons.sql';
    expect(ACKNOWLEDGED_CONTENT_DRIFT.get(filename)).toMatch(/comments-only.*db:check_drift/i);
    expect(selectNewContentDrift([entry(filename, 'unclassified')])).toEqual([]);
  });
});

describe('selectNewContentDrift (WI-10004651)', () => {
  const acknowledged = new Map([['100-known.sql', 'frozen fixture']]);

  it('reports hazardous drift outside the acknowledged set', () => {
    const got = selectNewContentDrift(
      [entry('100-known.sql', 'executable'), entry('200-new.sql', 'executable'), entry('300-new.sql', 'unclassified')],
      acknowledged,
    );
    expect(got.map((e) => e.filename)).toEqual(['200-new.sql', '300-new.sql']);
  });

  it('never reports an acknowledged entry, whatever its classification', () => {
    expect(selectNewContentDrift([entry('100-known.sql', 'unclassified')], acknowledged)).toEqual([]);
  });

  it('never reports a comment-only edit: the live DB and the file still correspond', () => {
    expect(selectNewContentDrift([entry('400-comment.sql', 'comments-only')], acknowledged)).toEqual([]);
  });

  it('defaults to the frozen set, so a frozen entry is quiet and an unknown one is not', () => {
    const got = selectNewContentDrift([
      entry('1219-blueprint-operation-invocations.sql', 'executable'),
      entry('9999-not-acknowledged.sql', 'executable'),
    ]);
    expect(got.map((e) => e.filename)).toEqual(['9999-not-acknowledged.sql']);
  });
});

describe('collectMigrationContentDriftSignals (WI-10004651)', () => {
  it('files one major bug per new drift entry, keyed by filename', async () => {
    const signals = await collectMigrationContentDriftSignals(async () => ({
      contentDriftNew: [entry('2001-x.sql', 'executable'), entry('2002-y.sql', 'unclassified')],
      contentDriftSqlDir: '/sql',
    }));
    expect(signals.map((s) => s.key)).toEqual([
      'migration-content-drift:2001-x.sql',
      'migration-content-drift:2002-y.sql',
    ]);
    for (const s of signals) {
      expect(s.source).toBe('migration-content-drift');
      expect(s.severity).toBe('major');
      expect(s.kind).toBe('bug');
      expect(s.body).toContain('ACKNOWLEDGED_CONTENT_DRIFT');
      expect(s.body).toContain('/sql');
    }
    expect(signals[0].paths).toEqual(['libs/papercusp/libs/db/sql/2001-x.sql']);
  });

  it('is silent when nothing is new, when drift was not measured, and when the check throws', async () => {
    expect(await collectMigrationContentDriftSignals(async () => ({ contentDriftNew: [] }))).toEqual([]);
    expect(await collectMigrationContentDriftSignals(async () => ({ contentDriftNew: null }))).toEqual([]);
    expect(
      await collectMigrationContentDriftSignals(async () => {
        throw new Error('pg down');
      }),
    ).toEqual([]);
  });

  it('is classified INFRA + defect and never auto-closes (drift does not self-heal)', () => {
    expect(INFRA_SIGNAL_SOURCES).toContain('migration-content-drift');
    expect(DEFECT_SOURCES).toContain('migration-content-drift');
    expect(AUTO_CLOSE_ELIGIBLE_SOURCES.has('migration-content-drift')).toBe(false);
  });
});

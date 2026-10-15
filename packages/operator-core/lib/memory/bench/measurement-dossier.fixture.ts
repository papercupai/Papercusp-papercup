/**
 * P-009 measurement-dossier fixture, shared by the unit and integration tiers.
 *
 * A throwaway git repository holding one committed evidence manifest per
 * promised bar, a nested repository standing in for a submodule (it carries a
 * second reliability manifest that the outer index does NOT track), and a
 * complete, committed dossier citing every manifest by its current fingerprint.
 * That complete dossier is the calibrated positive: every refusal the tests
 * exercise is a single edit away from it, so a verifier that refuses
 * everything fails the calibration case instead of passing the refusals.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEASUREMENT_BARS } from './measurement-manifest';
import { DOSSIER_PLAN, type DossierEvidenceRef, type MeasurementDossier } from './measurement-dossier';

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
export const git = (cwd: string, ...args: string[]) => execFileSync('git',
  ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
  { cwd, env, stdio: 'ignore' });

/** The plan item that measures each bar. */
export const BAR_ITEMS: Record<(typeof MEASUREMENT_BARS)[number], string> = {
  relevance: 'P-003', reference: 'P-002', hybrid: 'P-004', performance: 'P-005',
  boundaries: 'P-006', reliability: 'P-007', answers: 'P-008',
};

export interface DossierFixture {
  root: string;
  sub: string;
  dossierPath: string;
  dossier: MeasurementDossier;
  /** Overwrite the (still tracked) dossier file. */
  write(dossier: MeasurementDossier): void;
  /** Commit every change under docs/ in the outer repository. */
  commit(): void;
  cleanup(): void;
}

export function evidenceRef(root: string, rel: string): DossierEvidenceRef {
  const bytes = fs.readFileSync(path.join(root, rel));
  return { path: rel, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

export function dossierFixture(): DossierFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-dossier-')));
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'docs/evidence'), { recursive: true });
  for (const bar of MEASUREMENT_BARS) {
    fs.writeFileSync(path.join(root, `docs/evidence/${bar}.json`), JSON.stringify({ bar, item: BAR_ITEMS[bar], result: 'measured' }));
  }
  const sub = path.join(root, 'libs/sub');
  fs.mkdirSync(sub, { recursive: true });
  git(sub, 'init', '-q');
  fs.writeFileSync(path.join(sub, 'evidence.json'), JSON.stringify({ bar: 'reliability', part: 'submodule' }));
  git(sub, 'add', 'evidence.json');
  git(sub, 'commit', '-qm', 'sub');

  const dossier: MeasurementDossier = {
    formatVersion: 1, plan: DOSSIER_PLAN, recordedAt: '2026-10-06T00:00:00.000Z',
    recommendation: { decision: 'adopt-scoped', rationale: 'fixture verdict', scopes: ['prose'] },
    bars: MEASUREMENT_BARS.map((bar) => ({
      bar, items: [BAR_ITEMS[bar]], status: 'measured' as const, finding: `${bar} measured`,
      evidence: [evidenceRef(root, `docs/evidence/${bar}.json`),
        ...(bar === 'reliability' ? [evidenceRef(root, 'libs/sub/evidence.json')] : [])],
    })),
  };
  const dossierPath = path.join(root, 'docs/evidence/verdict.json');
  const write = (d: MeasurementDossier) => fs.writeFileSync(dossierPath, JSON.stringify(d, null, 2));
  const commit = () => { git(root, 'add', 'docs'); git(root, 'commit', '-qm', 'evidence'); };
  write(dossier);
  commit();
  return { root, sub, dossierPath, dossier, write, commit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

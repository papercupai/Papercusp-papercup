/**
 * P-009 measurement dossier, integration layer: the shipped CLI as a child
 * process over a real git repository on disk.
 *
 * The unit tier calls `verifyMeasurementDossier` in-process. Here the CLI's
 * argument parsing, its `fingerprint` output, and its exit status are the
 * production path: evidence references the CLI prints must round-trip into a
 * dossier the same CLI verifies (exit 0), and one byte changed in one cited
 * manifest afterwards must make it exit 1 naming that bar and path, with no
 * `verified` line on stdout.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MEASUREMENT_BARS } from './measurement-manifest';
import { dossierFixture, type DossierFixture } from './measurement-dossier.fixture';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CLI = path.join(REPO_ROOT, 'packages/operator-core/lib/memory/bench/measurement-dossier.ts');

function runCli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 90_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const fixtures: DossierFixture[] = [];
afterAll(() => { for (const f of fixtures) f.cleanup(); });

describe('measurement-dossier CLI over a real repository', () => {
  it('verifies a dossier built from its own fingerprint output, then refuses it after one cited byte changes', () => {
    const f = dossierFixture();
    fixtures.push(f);
    const paths = f.dossier.bars.flatMap((b) => b.evidence.map((e) => e.path));
    const printed = runCli('fingerprint', '--root', f.root, ...paths);
    expect(printed.status, printed.stderr).toBe(0);
    const refs = JSON.parse(printed.stdout) as Array<{ path: string }>;
    expect(refs.map((r) => r.path)).toEqual(paths);
    const byPath = new Map(refs.map((r) => [r.path, r]));
    f.write({ ...f.dossier, bars: f.dossier.bars.map((b) => ({ ...b, evidence: b.evidence.map((e) => byPath.get(e.path)!) })) as typeof f.dossier.bars });

    const ok = runCli('verify', f.dossierPath);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim().split('\n')).toEqual([
      ...MEASUREMENT_BARS.map((bar) => `${bar}\tmeasured\tdocs/evidence/${bar}.json${bar === 'reliability' ? ',evidence.json' : ''}`),
      'verified\tdocs/evidence/verdict.json\t7 bars',
    ]);

    fs.appendFileSync(path.join(f.root, 'docs/evidence/answers.json'), ' ');
    const stale = runCli('verify', f.dossierPath);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('stale evidence in answers: docs/evidence/answers.json');
    expect(stale.stdout).not.toContain('verified');
  });

  it('exits 1 with usage on a malformed invocation instead of verifying nothing', () => {
    const r = runCli('verify');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage: measurement-dossier.ts verify');
  });
});

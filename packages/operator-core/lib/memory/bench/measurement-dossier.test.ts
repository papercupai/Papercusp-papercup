import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from './measurement-dossier';
import { MEASUREMENT_BARS } from './measurement-manifest';
import { dossierFixture, type DossierFixture } from './measurement-dossier.fixture';
import type { MeasurementDossier } from './measurement-dossier';

// Copy-out mutation probes point PAPERCUSP_MUTATION_PROBE_SOURCE at the mutant.
const { verifyMeasurementDossier, fingerprintDossierEvidence }: typeof current = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
  ? await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)
  : current;

const fixtures: DossierFixture[] = [];
function fx(): DossierFixture {
  const f = dossierFixture();
  fixtures.push(f);
  return f;
}
afterAll(() => { for (const f of fixtures) f.cleanup(); });

async function refusal(file: string): Promise<string> {
  try {
    await verifyMeasurementDossier(file);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('dossier unexpectedly verified');
}

type Bar = MeasurementDossier['bars'][number];
const withBar = (f: DossierFixture, bar: Bar['bar'], patch: (b: Bar) => Bar): MeasurementDossier =>
  ({ ...f.dossier, bars: f.dossier.bars.map((b) => (b.bar === bar ? patch(b) : b)) });

describe('a shipped measurement verdict needs current proof for every promised bar (MDENSE-complete-measurement-verdict)', () => {
  it('verifies the complete fixture dossier and resolves submodule evidence inside its own repository', async () => {
    // Calibration: a verifier that refuses everything fails here, not in the refusal cases below.
    const f = fx();
    const result = await verifyMeasurementDossier(f.dossierPath);
    expect(result.dossier.repoRelative).toBe('docs/evidence/verdict.json');
    expect(result.bars.map((b) => b.bar)).toEqual([...MEASUREMENT_BARS]);
    const reliability = result.bars.find((b) => b.bar === 'reliability')!.evidence;
    expect(reliability.map((e) => [e.repoRoot, e.repoRelative])).toEqual([
      [f.root, 'docs/evidence/reliability.json'], [f.sub, 'evidence.json']]);
  });

  it('refuses a missing bar and a duplicated bar, naming both', async () => {
    const f = fx();
    const bars = f.dossier.bars.filter((b) => b.bar !== 'answers');
    f.write({ ...f.dossier, bars: [...bars, bars[0]] });
    const message = await refusal(f.dossierPath);
    expect(message).toContain('unmeasured promised bars: answers');
    expect(message).toContain('duplicated bars: relevance');
  });

  it('refuses an unknown status: an unfinished bar is not a status', async () => {
    const f = fx();
    f.write(withBar(f, 'hybrid', (b) => ({ ...b, status: 'unknown' as Bar['status'] })));
    expect(await refusal(f.dossierPath)).toContain('invalid dossier');
  });

  it('refuses evidence edited after the verdict was recorded, even when the edit is committed', async () => {
    const f = fx();
    fs.appendFileSync(path.join(f.root, 'docs/evidence/hybrid.json'), '\n');
    f.commit();
    const message = await refusal(f.dossierPath);
    expect(message).toMatch(/stale evidence in hybrid: docs\/evidence\/hybrid\.json \(recorded [0-9a-f]{12}\/\d+B, now [0-9a-f]{12}\/\d+B\)/);
    expect(message).not.toMatch(/in relevance|in answers/);
  });

  it('refuses absent, untracked and non-portable evidence, naming every one', async () => {
    const f = fx();
    fs.writeFileSync(path.join(f.root, 'docs/evidence/loose.json'), '{}');
    const [loose] = await fingerprintDossierEvidence(f.root, ['docs/evidence/loose.json']);
    const absolute = path.join(f.root, 'docs/evidence/performance.json');
    f.write(withBar(f, 'performance', (b) => ({ ...b, evidence: [...b.evidence, loose,
      { ...loose, path: 'docs/evidence/gone.json' }, { ...loose, path: '../outside.json' }, { ...loose, path: absolute }] })));
    const message = await refusal(f.dossierPath);
    for (const expected of ['untracked evidence in performance: docs/evidence/loose.json',
      'absent evidence in performance: docs/evidence/gone.json',
      'non-portable evidence path in performance: ../outside.json',
      `non-portable evidence path in performance: ${absolute}`]) expect(message).toContain(expected);
  });

  it('accepts an incompatible bar only with an owned, filed defect', async () => {
    const f = fx();
    const incompatible = (defects?: Bar['defects']) => withBar(f, 'boundaries', (b) => ({ ...b, status: 'incompatible', ...(defects ? { defects } : {}) }));
    f.write(incompatible());
    expect(await refusal(f.dossierPath)).toContain('incompatible bar without an owned defect: boundaries');
    f.write(incompatible([{ owner: 'su-fixture', item: 'TODO', rootCause: 'r', guard: 'g' }]));
    expect(await refusal(f.dossierPath)).toContain('invalid dossier');
    f.write(incompatible([{ owner: 'su-fixture', item: 'WI-1', rootCause: 'r', guard: 'g' }]));
    await expect(verifyMeasurementDossier(f.dossierPath)).resolves.toMatchObject({ bars: expect.arrayContaining([{ bar: 'boundaries', status: 'incompatible', evidence: expect.any(Array) }]) });
  });

  it('refuses an untracked dossier even when every bar it cites is current', async () => {
    const f = fx();
    const copy = path.join(f.root, 'docs/evidence/verdict-copy.json');
    fs.copyFileSync(f.dossierPath, copy);
    const message = await refusal(copy);
    expect(message).toContain(`dossier is not tracked: ${copy}`);
    expect(message).not.toContain('evidence in');
  });
});

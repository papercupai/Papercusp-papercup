/**
 * P-002 proof of the `LOST_PIXEL_GENERATE_META` metadata pathway, exercised
 * end-to-end against the installed Lost Pixel with ARBITRARY IMAGE BASELINES.
 *
 * The plan assumes per-image comparison metadata can be recovered from Lost Pixel
 * for references that are just images on disk, rather than Storybook stories. It
 * can: `checkDifferences` writes `<imagePathCurrent>/meta.json` when meta
 * generation is enabled, keyed by shot id.
 *
 * But the contract has a hole that is invisible unless you run it, and it is the
 * third independent fail-open in this dependency:
 *
 *     A shot with NO BASELINE is ABSENT FROM meta.json ENTIRELY.
 *
 * `checkDifferences` pushes such a shot onto `noBaselinesItems` and returns EARLY,
 * before the line that records its metadata. So the file cannot distinguish
 * "compared, and identical" from "never compared, because there was nothing to
 * compare against". Any consumer that reads meta.json and treats a missing key as
 * benign will pass a surface that was never checked — which is precisely the
 * "missing evidence must refuse completion" case P-007 exists to enforce.
 *
 * DEFENCE, recorded here so P-005 inherits it: the adapter must treat meta.json as
 * a partial index keyed by shot id and reconcile it against the EXPECTED shot set,
 * mapping any expected-but-absent id to `invalid` with a missing-baseline reason.
 * It must never iterate meta.json's own keys as if they were the population.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRaster, encodePng } from './corpus/synthesize';

const requireCjs = createRequire(import.meta.url);

it('loads a TypeScript Lost Pixel config through the real runtime esbuild consumer', async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'lost-pixel-runtime-config-'));
  try {
    const lostPixelRequire = createRequire(requireCjs.resolve('lost-pixel/package.json'));
    const esbuild = lostPixelRequire('esbuild') as {
      version: string;
      transformSync: (input: string, options: { loader: string }) => { code: string };
    };
    expect(esbuild.version).toBe('0.28.2');
    expect(esbuild.transformSync('const threshold: number = 0.02;', { loader: 'ts' }).code)
      .toContain('const threshold = 0.02');
    const configPath = path.join(fixture, 'lostpixel.config.ts');
    writeFileSync(configPath, [
      'const threshold: number = 0.02;',
      'export default { compareEngine: "pixelmatch", threshold, storybookShots: false };',
    ].join('\n'));
    const helper = requireCjs('lost-pixel/dist/configHelper.js') as {
      loadProjectConfigFile: (file: string) => Promise<Record<string, unknown>>;
    };
    await expect(helper.loadProjectConfigFile(configPath)).resolves.toEqual({
      compareEngine: 'pixelmatch', threshold: 0.02, storybookShots: false,
    });
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

interface ShotItem {
  id: string;
  shotName: string;
  shotMode: string;
  threshold: number;
  filePathBaseline: string;
  filePathCurrent: string;
  filePathDifference: string;
}

interface CheckDifferencesResult {
  aboveThresholdDifferenceItems: ShotItem[];
  noBaselinesItems: ShotItem[];
}

let workDir: string;
let currentDir: string;
let baselineDir: string;
let result: CheckDifferencesResult;
let meta: Record<string, unknown>;
let previousMetaEnv: string | undefined;

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'design-compare-meta-'));
  baselineDir = path.join(workDir, 'baseline');
  currentDir = path.join(workDir, 'current');
  const differenceDir = path.join(workDir, 'difference');
  for (const dir of [baselineDir, currentDir, differenceDir]) mkdirSync(dir, { recursive: true });

  const write = (dir: string, name: string, colour: [number, number, number]): void =>
    writeFileSync(path.join(dir, `${name}.png`), encodePng(createRaster(40, 40, colour)));

  // 'identical'  — baseline and current agree.
  write(baselineDir, 'identical', [255, 255, 255]);
  write(currentDir, 'identical', [255, 255, 255]);
  // 'regressed'  — baseline and current differ.
  write(baselineDir, 'regressed', [255, 255, 255]);
  write(currentDir, 'regressed', [0, 0, 0]);
  // 'unbaselined' — CURRENT ONLY. This is the shot that disappears.
  write(currentDir, 'unbaselined', [12, 34, 56]);

  // Lost Pixel reads a module-global config object rather than taking one as an
  // argument, so driving `checkDifferences` means assigning to that export. This
  // is why the proof lives in its own test file: the assignment is process-wide.
  const configModule = requireCjs('lost-pixel/dist/config.js') as {
    config: Record<string, unknown>;
  };
  configModule.config = {
    compareEngine: 'pixelmatch',
    compareConcurrency: 1,
    imagePathBaseline: baselineDir,
    imagePathCurrent: currentDir,
    imagePathDifference: differenceDir,
  };

  previousMetaEnv = process.env.LOST_PIXEL_GENERATE_META;
  process.env.LOST_PIXEL_GENERATE_META = 'true';

  const { checkDifferences } = requireCjs('lost-pixel/dist/checkDifferences.js') as {
    checkDifferences: (shots: ShotItem[]) => Promise<CheckDifferencesResult>;
  };

  const shot = (id: string): ShotItem => ({
    id,
    shotName: id,
    shotMode: 'image',
    threshold: 0,
    filePathBaseline: path.join(baselineDir, `${id}.png`),
    filePathCurrent: path.join(currentDir, `${id}.png`),
    filePathDifference: path.join(differenceDir, `${id}.png`),
  });

  result = await checkDifferences([shot('identical'), shot('regressed'), shot('unbaselined')]);
  meta = JSON.parse(readFileSync(path.join(currentDir, 'meta.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}, 60_000);

afterAll(() => {
  if (previousMetaEnv === undefined) delete process.env.LOST_PIXEL_GENERATE_META;
  else process.env.LOST_PIXEL_GENERATE_META = previousMetaEnv;
  rmSync(workDir, { recursive: true, force: true });
});

describe('the meta.json pathway works for arbitrary image baselines', () => {
  it('writes meta.json into imagePathCurrent when meta generation is enabled', () => {
    expect(existsSync(path.join(currentDir, 'meta.json'))).toBe(true);
  });

  it('keys entries by shot id and carries exactly the three documented fields', () => {
    expect(Object.keys(meta).sort()).toEqual(['identical', 'regressed']);
    for (const entry of Object.values(meta)) {
      expect(Object.keys(entry as object).sort()).toEqual([
        'isWithinThreshold',
        'pixelDifference',
        'pixelDifferencePercentage',
      ]);
    }
  });

  it('reports real counts for the shots it does describe', () => {
    expect(meta.identical).toMatchObject({ pixelDifference: 0, isWithinThreshold: true });
    expect(meta.regressed).toMatchObject({ pixelDifference: 1600, isWithinThreshold: false });
  });
});

describe('HAZARD: meta.json silently omits shots that had no baseline', () => {
  it('describes only 2 of the 3 submitted shots', () => {
    // The headline. Three shots went in; the metadata file speaks about two.
    expect(Object.keys(meta)).toHaveLength(2);
    expect(meta).not.toHaveProperty('unbaselined');
  });

  it('surfaces the omitted shot ONLY on the return value, not in the file', () => {
    // The information is not lost — it is on a different channel. An adapter that
    // consumes the artifact rather than the return value never sees it, which is
    // exactly the shape of a CI integration that reads meta.json from disk.
    expect(result.noBaselinesItems.map((item) => item.id)).toEqual(['unbaselined']);
    expect(result.aboveThresholdDifferenceItems.map((item) => item.id)).toEqual(['regressed']);
  });

  it('makes absence ambiguous, which is why the adapter must reconcile against an expected set', () => {
    // DEFENCE, stated as a test: reconciling the expected population against the
    // file's keys is what turns a silent omission into an explicit `invalid`.
    const expectedShots = ['identical', 'regressed', 'unbaselined'];
    const described = new Set(Object.keys(meta));
    const missing = expectedShots.filter((id) => !described.has(id));

    expect(missing).toEqual(['unbaselined']);
    // Without the expected set there is nothing to detect: the file alone looks
    // complete and internally consistent.
    expect(Object.keys(meta).every((id) => described.has(id))).toBe(true);
  });
});

describe('HAZARD: meta.json cannot support a recomputed ratio on its own', () => {
  it('carries no dimensions, so the denominator is unrecoverable for a zero-difference shot', () => {
    // P-005 must recompute the verdict from raw counts under a versioned policy,
    // which needs a denominator. meta.json supplies `pixelDifference` and a
    // percentage, so pixelsTotal is derivable by division ONLY when the difference
    // is non-zero. For an identical shot both are 0 and 0/0 is undefined.
    const identical = meta.identical as { pixelDifference: number; pixelDifferencePercentage: number };
    expect(identical.pixelDifference).toBe(0);
    expect(identical.pixelDifferencePercentage).toBe(0);
    expect(Number.isNaN(identical.pixelDifference / identical.pixelDifferencePercentage)).toBe(true);

    // DEFENCE: read dimensions from the images themselves rather than inferring a
    // denominator from the metadata.
    const regressed = meta.regressed as { pixelDifference: number; pixelDifferencePercentage: number };
    expect(regressed.pixelDifference / regressed.pixelDifferencePercentage).toBe(40 * 40);
  });
});

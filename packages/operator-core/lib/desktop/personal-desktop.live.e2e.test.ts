/** Real-host P-006 proof; test:file routes this file through the measured e2e project.
 * Opt in with PAPERCUSP_PERSONAL_DESKTOP_LIVE=1 and explicit ORG/CWS/HOST/INST/PROJECT/ZONE/OUT.
 * Explicit scorecard-check runs use the maintained P-006 host coordinates and a fresh OUT.
 * The profile supplies coordinates only: every verdict is measured again on the real host.
 * OUT must name a new artifact; the historical live-run.json is never overwritten.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { personalDesktopLiveMode, personalDesktopScorecardEnvironment } from './personal-desktop-live-config';
import { allowRealPgForLiveSuite } from '../testing/live-suite-real-pg';

const mode = personalDesktopLiveMode(process.env);
const live = mode !== 'off';
allowRealPgForLiveSuite(live);

describe.skipIf(!live)('personal desktop on a real workspace host', () => {
  let observed: Awaited<ReturnType<typeof import('./personal-desktop-live-driver').runPersonalDesktopLive>>;
  const previous = new Map<string, string | undefined>();
  afterAll(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeAll(async () => {
    if (mode === 'scorecard') {
      const repo = new URL('../../../../', import.meta.url);
      const profile = JSON.parse(readFileSync(new URL('docs/evidence/personal-cloud-desktop-2026-10-06/live-e2e-committed-20261007-0725.json', repo), 'utf8'));
      const run = `p006-scorecard-${randomUUID()}`;
      const directory = new URL('.papercusp/scratch/pcd/', repo);
      mkdirSync(directory, { recursive: true });
      const output = new URL(`${run}.json`, directory).pathname;
      for (const [key, value] of Object.entries(personalDesktopScorecardEnvironment(profile, output, run))) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }
      console.log('Fresh personal desktop live grading output:', output);
    }
    for (const name of ['ORG', 'CWS', 'HOST', 'INST', 'PROJECT', 'ZONE', 'OUT']) {
      if (!process.env[name]) throw new Error(`Missing live precondition: ${name}`);
    }
    if (existsSync(process.env.OUT!)) throw new Error('Live evidence output already exists; choose a fresh OUT');
    const { runPersonalDesktopLive } = await import('./personal-desktop-live-driver');
    observed = await runPersonalDesktopLive();
  }, 240_000);

  for (const assertion of [
    'personal-desktop-uid',
    'personal-desktop-home',
    'personal-desktop-takeover-input',
    'personal-desktop-reconnect',
    'personal-desktop-non-owner-refused',
  ]) {
    it(assertion, () => {
      expect(observed.assertions[assertion], 'The real driver must have measured this assertion').toBeDefined();
      expect(observed.assertions[assertion].passed).toBe(true);
    });
  }
});

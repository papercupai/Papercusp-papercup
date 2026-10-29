// Read-only browser measurement for P-001; this is not a test or acceptance proof.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../apps/operator/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3170';
const outputPath = process.argv[3] ?? '/tmp/rules-events-ui-before.json';
const sampleMs = 300_000;
const warmupMs = 30_000;
const file = fileURLToPath(import.meta.url);
const queryHash = createHash('sha256').update(readFileSync(file)).digest('hex');
const targets = [
  { panel: 'FleetRateControl', path: '/adv?tab=overview&ws=papercusp-workspace', endpoint: '/api/operator/rate-limit-config' },
  { panel: 'AdvFramesTab', path: '/adv?tab=frames&ws=papercusp-workspace', endpoint: '/api/deploy/frames' },
  { panel: 'DogfoodSubstrate', path: '/admin/dogfood-substrate?ws=papercusp-workspace', endpoint: '/api/admin/dogfood-substrate-health' },
];
const result = { schemaVersion: 1, kind: 'measurement', queryFile: file, queryHash, baseUrl, sampleMs, warmupMs, startedAt: new Date().toISOString(), scenarios: [], errors: [] };
const persist = () => writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
const browser = await chromium.launch({ headless: true });
try {
  for (const subscribers of [1, 2]) {
    const contexts = [];
    const samples = [];
    const scenario = { subscribersPerPanel: subscribers, pages: [], status: 'warming' };
    result.scenarios.push(scenario);
    persist();
    try {
      for (const target of targets) {
        for (let index = 0; index < subscribers; index++) {
          const context = await browser.newContext();
          contexts.push(context);
          const page = await context.newPage();
          const sample = { panel: target.panel, pageIndex: index, route: target.path, endpoint: target.endpoint, startupTargetResponses: 0, requests: [], failures: [], visibility: null, url: null };
          samples.push(sample);
          scenario.pages.push(sample);
          await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
          });
          page.on('request', (request) => {
            const path = new URL(request.url()).pathname;
            if (scenario.status === 'sampling' && path === target.endpoint) sample.requests.push({ at: new Date().toISOString(), method: request.method() });
          });
          page.on('response', (response) => {
            const path = new URL(response.url()).pathname;
            if (path === target.endpoint) sample.startupTargetResponses++;
            if (response.status() >= 400 && path.startsWith('/api/') && sample.failures.length < 20) {
              sample.failures.push({ at: new Date().toISOString(), path, status: response.status() });
            }
          });
          page.on('pageerror', (error) => sample.failures.push({ at: new Date().toISOString(), pageError: error.message.slice(0, 250) }));
          await page.goto(new URL(target.path, baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          // A real response from this panel is the mount witness; a loaded shell is insufficient.
          await page.waitForResponse((response) => new URL(response.url()).pathname === target.endpoint, { timeout: 45_000 }).catch(() => {
            if (sample.startupTargetResponses === 0) throw new Error(`No mounted endpoint witness for ${target.panel}`);
          });
          sample.visibility = await page.evaluate(() => document.visibilityState);
          sample.url = page.url();
          if (sample.visibility !== 'visible') throw new Error(`Hidden ${target.panel} page would confound timer counts`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, warmupMs));
      scenario.status = 'sampling';
      scenario.sampleStartedAt = new Date().toISOString();
      persist();
      console.log(JSON.stringify({ phase: 'sample-start', subscribers, pages: samples.length, sampleMs, queryHash }));
      for (let elapsed = 0; elapsed < sampleMs; elapsed += 30_000) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, sampleMs - elapsed)));
        persist();
        console.log(JSON.stringify({ phase: 'sample-progress', subscribers, elapsedMs: elapsed + 30_000, counts: samples.map((sample) => [sample.panel, sample.pageIndex, sample.requests.length]) }));
      }
      scenario.sampleEndedAt = new Date().toISOString();
      scenario.status = 'complete';
      persist();
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  }
  result.status = 'complete';
} catch (error) {
  result.status = 'failed';
  result.errors.push(String(error));
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  persist();
  await browser.close();
  console.log(JSON.stringify({ phase: 'finished', status: result.status, outputPath, queryHash }));
}

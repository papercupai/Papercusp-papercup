/** Exercise the actual portable HTML renderer in Chromium, without an operator or inference. */
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReportHtml, bundleFromRollouts } from './report-builder';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30000);
afterAll(async () => { await browser?.close(); });

describe('portable report cost comparisons', () => {
  it('renders measured costs, dominated arms and unknown winner accounting through the real viewer', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const bundle = bundleFromRollouts({ runId: 'portable-costs', suite: 'swe-bench-pro', createdAt: '2026-10-11',
        arms: ['cheap', 'dear', 'unknown'], models: {}, assignedTaskIds: ['t1'], assignedSeeds: [0],
        runResults: ['cheap', 'dear', 'unknown'].map(arm => ({ taskId: 't1', arm, seed: 0,
          resolved: true, graderStatus: 'passed', generationStatus: 'completed',
          costUsd: arm === 'dear' ? 4 : 2, tokensIn: 10, tokensOut: 20, tokensTotal: 30, wallClockMs: 100,
          armMeta: arm === 'unknown' ? { costUsdMeasurementMissing: true } : null })) });
      await page.setContent(buildReportHtml(bundle));
      const comparison = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Cost versus assigned outcome' }) });
      await comparison.waitFor();
      expect(await page.getByRole('columnheader', { name: '$/assigned task (all seeds)', exact: true }).count()).toBe(1);
      const points = comparison.locator('table').first();
      expect(await points.getByRole('row').filter({ hasText: 'cheap' }).textContent()).toContain('On frontier');
      expect(await points.getByRole('row').filter({ hasText: 'dear' }).textContent()).toContain('Dominated');
      expect(await points.getByRole('row').filter({ hasText: 'unknown' }).textContent()).toContain('incomplete cost accounting');
      const winners = comparison.locator('table').nth(1);
      expect(await winners.textContent()).toContain('cheap · $2');
      expect(await winners.textContent()).toContain('dear · $4');
      expect(await winners.textContent()).toContain('unknown · unknown cost');
      await page.getByRole('button', { name: 'Rollouts' }).click();
      expect(await page.getByRole('searchbox').count()).toBe(1);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
});

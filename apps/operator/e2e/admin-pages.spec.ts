/**
 * Admin pages — render-without-crash smoke for the operator's admin surface.
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('admin pages', () => {
  test('/admin renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  test('/admin/run renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/run`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  test('/admin/features renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/features`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  test('/admin/tables renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/tables`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  // The deploy/git-sync journey (WI-3204 audit): the agent-e2e doc's own
  // coverage checklist (§13) lists `/admin/{plans,git,features,tables,dbos,run}`
  // as a unit, with "/admin/git pipeline view renders" called out explicitly —
  // but before this, only run/features/tables had ANY e2e smoke. /admin/git,
  // /admin/dbos, and /admin/plans (route-level; plan-detail-flow.spec.ts
  // covers plan-detail interaction separately) had zero coverage.
  test('/admin/git renders without 500 and shows the pipeline view', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/git`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
    // GitClient.tsx: stable "Pipeline" heading, present regardless of sync data.
    await expect(page.getByText('Pipeline', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('/admin/git renders the API non-verdict reasons without treating unknown as zero', async ({ page }, testInfo) => {
    const healthBeforeResponse = await page.request.get(`${baseURL}/api/health`);
    expect(healthBeforeResponse.ok()).toBe(true);
    const healthBefore = await healthBeforeResponse.json();
    expect(healthBefore.sha).toEqual(expect.any(String));

    // Observe the real snapshot consumed by this browser; do not replace the API
    // with a fixture or sample a second request whose counts may have changed.
    const snapshotResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/rest-query') && url.searchParams.get('name') === 'dev.gitPipeline';
    });
    const navigation = await page.goto(`${baseURL}/admin/git`, { waitUntil: 'load' });
    expect(navigation?.status()).toBe(200);
    const response = await snapshotResponse;
    expect(response.ok()).toBe(true);
    const snapshot = await response.json();
    expect(snapshot.rows).toHaveLength(1);
    const pipeline = snapshot.rows[0];
    const slo = pipeline.gate.slo;
    expect(slo).toBeTruthy();
    expect(slo.unreadable).toEqual(expect.any(Array));
    const panel = page.getByTestId('gate-non-verdict-reasons');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Non-verdict reasons · last 24h');
    await expect(panel).toContainText(`Owned follow-up at ${slo.thresholds.nonVerdictReasonMinCount} outcomes per reason.`);
    expect(slo.thresholds.nonVerdictReasonMinCount).toBeGreaterThan(0);

    const reasons = slo.metrics.nonVerdictReasons;
    if (reasons == null) {
      await expect(panel).toContainText(slo.unreadable.includes('nonVerdictReasons') ? 'unknown · ledger unreadable' : 'not measured');
      await expect(panel).not.toContainText('0 terminal skips or aborts');
    } else {
      expect(reasons.windowHours).toBe(24);
      expect(reasons.measuredAtMs).toBeGreaterThan(0);
      expect(reasons.reasons).toEqual(expect.any(Array));
      if (reasons.reasons.length === 0) {
        await expect(panel).toContainText('0 terminal skips or aborts');
      } else {
        await expect(panel.locator('li')).toHaveCount(reasons.reasons.length);
        for (const row of reasons.reasons) {
          expect(row.count).toBeGreaterThan(0);
          await expect(panel.getByText(`${row.reason}: ${row.count}`, { exact: true })).toBeVisible();
        }
      }
    }

    const healthAfterResponse = await page.request.get(`${baseURL}/api/health`);
    expect(healthAfterResponse.ok()).toBe(true);
    const healthAfter = await healthAfterResponse.json();
    expect(healthAfter.sha, 'the serving build must stay fixed during acceptance').toBe(healthBefore.sha);
    await testInfo.attach('non-verdict-reasons-acceptance', {
      body: JSON.stringify({ origin: baseURL, healthBefore, healthAfter, slug: pipeline.slug, slo, rendered: await panel.innerText() }, null, 2),
      contentType: 'application/json',
    });
  });

  test('/admin/dbos renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/dbos`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });

  test('/admin/plans renders without 500', async ({ page }) => {
    const res = await page.goto(`${baseURL}/admin/plans`, { waitUntil: 'load' });
    expect([200, 302, 307]).toContain(res?.status() ?? 0);
  });
});

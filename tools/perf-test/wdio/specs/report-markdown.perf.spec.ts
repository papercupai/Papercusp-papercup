/**
 * Fresh packaged-Tauri responsiveness check for the operator report Markdown
 * renderer. The fixture mounts real ReportBlockCard items and emits the same
 * page-relative measures used by the long-lived desktop performance suite.
 */
import { browser } from '@wdio/globals';
import { recordInteractionMs } from '../perf-report';
import { waitForAppMount } from '../app-mount';

const FIRST_MOUNT = 'report-markdown-first-mount';
const INPUT_DELAY = 'report-markdown-input-delay';
const FIRST_MOUNT_BUDGET_MS = 1500;
const INPUT_DELAY_BUDGET_MS = 200;
const ITEM_COUNT = 23;

async function navigate(path: string): Promise<void> {
  await browser.execute((target) => {
    const state = (history.state ?? {}) as Record<string, unknown>;
    const index = typeof state.__TSR_index === 'number' ? state.__TSR_index : 0;
    history.pushState({ ...state, __TSR_index: index + 1 }, '', target);
  }, path);
}

describe('Packaged Papercusp desktop — report markdown responsiveness', () => {
  it('commits a representative report promptly and yields to queued input', async () => {
    await navigate('/admin/report-markdown-perf');
    await waitForAppMount(browser);
    await browser.waitUntil(
      async () => await browser.execute(() => Boolean(document.querySelector('[data-testid="report-markdown-perf-trigger"]'))),
      { timeout: 20_000, timeoutMsg: 'report Markdown performance fixture did not mount' },
    );

    await browser.execute(() => {
      performance.clearMeasures('report-markdown-first-mount');
      performance.clearMarks('report-markdown-first-mount:start');
      performance.clearMeasures('report-markdown-input-delay');
      performance.clearMarks('report-markdown-input-delay:start');
    });
    await browser.$('[data-testid="report-markdown-perf-trigger"]').click();
    await browser.waitUntil(
      async () => await browser.execute(() =>
        performance.getEntriesByName('report-markdown-first-mount', 'measure').length > 0 &&
        performance.getEntriesByName('report-markdown-input-delay', 'measure').length > 0),
      { timeout: 15_000, timeoutMsg: 'report Markdown measures were not emitted' },
    );

    const measures = await browser.execute(() => {
      const latest = (name: string) => {
        const entries = performance.getEntriesByName(name, 'measure');
        return entries.length ? Math.round(entries[entries.length - 1].duration) : null;
      };
      return {
        firstMountMs: latest('report-markdown-first-mount'),
        inputDelayMs: latest('report-markdown-input-delay'),
        formattedItems: document.querySelectorAll('[data-testid="report-markdown-perf-content"] .report-block-item-text strong').length,
      };
    });
    if (measures.firstMountMs === null || measures.inputDelayMs === null) {
      throw new Error('report Markdown timing measures were missing');
    }

    recordInteractionMs(FIRST_MOUNT, measures.firstMountMs, FIRST_MOUNT_BUDGET_MS);
    recordInteractionMs(INPUT_DELAY, measures.inputDelayMs, INPUT_DELAY_BUDGET_MS);
    expect(measures.firstMountMs).toBeLessThanOrEqual(FIRST_MOUNT_BUDGET_MS);
    expect(measures.inputDelayMs).toBeLessThanOrEqual(INPUT_DELAY_BUDGET_MS);
    await browser.waitUntil(
      async () => await browser.execute((count) =>
        document.querySelectorAll('[data-testid="report-markdown-perf-content"] .report-block-item-text strong').length === count,
      ITEM_COUNT),
      { timeout: 10_000, timeoutMsg: 'the complete formatted report did not hydrate' },
    );
  });
});

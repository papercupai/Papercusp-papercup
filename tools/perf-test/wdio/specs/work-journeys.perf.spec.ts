/** Real gestures against a private, explicitly offered human-work fixture. */
import { browser } from '@wdio/globals';
import { waitForAppMount, waitForPackagedAppUrl } from '../app-mount';
import { bindVerifierEnvironment, recordInteractionMs, workJourneyDuration,
  type WorkJourneyReading } from '../perf-report';

const BUDGET_MS = 1500; // desktop-perf-budgets.ts provisional journey limits
type Journey = 'work-list-open' | 'work-item-open' | 'work-item-claim';

async function measure(name: Journey, selector: string, itemId: string): Promise<void> {
  const target = await browser.$(selector);
  await target.waitForDisplayed({ timeout: 20_000 });
  await target.waitForEnabled({ timeout: 20_000 });
  const boundary = await browser.execute((interaction) => {
    performance.clearMeasures(interaction);
    performance.clearMarks(interaction + ':start');
    return { gestureAt: performance.now(), timeOrigin: performance.timeOrigin };
  }, name);
  let reading: WorkJourneyReading | null = null;
  let duration: number | null = null;
  try {
    await target.click();
    await browser.waitUntil(async () => {
      reading = await browser.execute((interaction, id, timeOrigin) => {
        const w = window as Window & { __papercuspServerConnectionRestored?: boolean;
          __papercuspServerConnectionRequired?: string; __papercuspBootError?: string };
        const detail = Array.from(document.querySelectorAll('.pc-adv-detail'))
          .find(el => el.querySelector('.pc-adv-detail__id')?.textContent === id);
        const contentReady = interaction === 'work-list-open'
          ? Array.from(document.querySelectorAll('[role="row"] code')).some(el => el.textContent === id)
          : interaction === 'work-item-open' ? Boolean(detail?.querySelector('.pc-adv-detail__fields'))
          : Boolean(detail?.querySelector('textarea') && detail.querySelector('button[type="submit"]') &&
            !detail.querySelector('[aria-label="Claim this work"]'));
        return { now: performance.now(), contentReady,
          connectionReady: performance.timeOrigin === timeOrigin &&
            w.__papercuspServerConnectionRestored === true && !w.__papercuspServerConnectionRequired &&
            !w.__papercuspBootError && !document.querySelector('[data-testid="server-connection-reason"]'),
          entries: performance.getEntriesByName(interaction, 'measure')
            .map(entry => ({ startTime: entry.startTime, duration: entry.duration })) };
      }, name, itemId, boundary.timeOrigin);
      duration = workJourneyDuration(reading, boundary.gestureAt);
      return duration !== null;
    }, { timeout: 20_000, timeoutMsg: name + ': no fresh measure with committed fixture content' });
  } finally {
    console.log('[work-journey]', JSON.stringify({ name, itemId, boundary, reading }));
    recordInteractionMs(name, duration, BUDGET_MS);
  }
  const measured = duration as number | null; // assigned by the async wait callback
  if (measured === null) throw new Error(name + ': instrument or content unavailable');
  expect(measured).toBeLessThanOrEqual(BUDGET_MS);
}

describe('Packaged Papercusp desktop — work journeys', () => {
  it('opens the work list and item, then claims an offer with a real human session', async () => {
    if (!bindVerifierEnvironment()) throw new Error('Work journeys require the private isolated verifier');
    const harness = process.env.PAPERCUSP_PERF_HARNESS;
    const itemId = process.env.PAPERCUSP_PERF_WORK_ITEM;
    const username = process.env.PAPERCUSP_PERF_HUMAN_USERNAME;
    if (!harness || !itemId || !username || !/^[\w-]+$/.test(harness) || !/^[\w-]+$/.test(itemId) ||
        !/^perf-human-[a-z0-9_-]+$/.test(username)) throw new Error('Missing private human-work fixture');
    const appUrl = new URL(await waitForPackagedAppUrl(browser));
    appUrl.pathname = '/adv';
    appUrl.search = new URLSearchParams({ ws: process.env.PAPERCUSP_PERF_WORKSPACE_ID!,
      slug: harness, scope: 'self', tab: 'overview' }).toString();
    appUrl.hash = '';
    await browser.url(appUrl.toString());
    await waitForAppMount(browser);

    // Login through the same IPC fetch/cookie jar used by the product. No
    // injected identity header, bearer-only claim, or mocked claim response.
    const preflight = await browser.executeAsync(async (user, slug, id, done) => {
      try {
        const login = await fetch('/api/auth/login', { method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user }) });
        if (!login.ok) return done({ ok: false, phase: 'login', status: login.status });
        const offer = await fetch('/api/harness/' + encodeURIComponent(slug) + '/work-items/' +
          encodeURIComponent(id) + '/human-work', { credentials: 'include' });
        const body = await offer.json();
        done({ ok: offer.ok && body.offer?.id === id && body.offer?.status === 'available' &&
          body.mine === false && body.version === 0, phase: 'offer', status: offer.status });
      } catch { done({ ok: false, phase: 'transport', status: 0 }); }
    }, username, harness, itemId) as { ok: boolean; phase: string; status: number };
    if (!preflight.ok) throw new Error('Human fixture not authenticated/available: ' + JSON.stringify(preflight));

    await measure('work-list-open', '.pc-overview [aria-label="Open Work items"]', itemId);
    await measure('work-item-open', '[role="row"]:has(code[title="' + itemId + '"])', itemId);
    await measure('work-item-claim', '.pc-adv-detail [aria-label="Claim this work"]', itemId);
    const claimed = await browser.executeAsync(async (slug, id, done) => {
      try {
        const response = await fetch('/api/harness/' + encodeURIComponent(slug) + '/work-items/' +
          encodeURIComponent(id) + '/human-work', { credentials: 'include' });
        const body = await response.json();
        done(response.ok && body.mine === true && body.offer?.status === 'claimed' && body.version === 1);
      } catch { done(false); }
    }, harness, itemId);
    expect(claimed).toBe(true);
  });
});

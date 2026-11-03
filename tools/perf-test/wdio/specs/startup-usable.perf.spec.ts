/** Fresh native process entry to the committed, usable landing Overview. */
import { browser } from '@wdio/globals';
import { realpathSync } from 'node:fs';
import { nativeStartupDuration, recordInteractionMs, recordMeasure, type NativeStartupReading } from '../perf-report';
import { waitForAppMount } from '../app-mount';

describe('Packaged Papercusp desktop — startup to usable content', () => {
  it('records the full fresh-process span including work before page navigation', async () => {
    const sessionStartedAtMs = Number(process.env.PAPERCUSP_PERF_NATIVE_SESSION_STARTED_MS);
    // Do not navigate/reload or clear the first startup measure. A fresh
    // session must naturally land on usable content, not an injected fixture.
    await waitForAppMount(browser);
    const read = async (): Promise<NativeStartupReading> => browser.execute(() => {
      const w = window as Window & {
        __papercuspStartupOrigin?: NativeStartupReading['origin'];
        __papercuspServerConnectionRestored?: boolean;
        __papercuspServerConnectionRequired?: string;
        __papercuspBootError?: string;
      };
      return {
        origin: w.__papercuspStartupOrigin ?? null,
        entries: performance.getEntriesByName('startup-usable', 'measure').map((entry) => ({
          duration: entry.duration, detail: (entry as PerformanceMeasure).detail,
        })),
        capturedAtEpochMs: performance.timeOrigin + performance.now(),
        overview: Boolean(document.querySelector('[data-testid="operator-shell"] .pc-overview')),
        connectionReady: w.__papercuspServerConnectionRestored === true &&
          !w.__papercuspServerConnectionRequired && !w.__papercuspBootError &&
          !document.querySelector('[data-testid="server-connection-reason"]'),
      };
    });
    let reading = await read();
    let duration = nativeStartupDuration(reading, sessionStartedAtMs);
    try {
      await browser.waitUntil(async () => {
        reading = await read();
        duration = nativeStartupDuration(reading, sessionStartedAtMs);
        return duration !== null;
      }, { timeout: 60_000, timeoutMsg: 'no verified native entry-to-usable Overview measure within 60s' });
      // On Linux independently bind the reported PID to this session's exact
      // application bytes, rather than trusting a page-owned PID by itself.
      if (process.platform === 'linux') {
        try {
          expect(realpathSync('/proc/' + reading.origin!.pid + '/exe'))
            .toBe(realpathSync(process.env.TAURI_APP_PATH!));
        } catch (error) {
          duration = null; // unverified process must not publish a timing
          throw error;
        }
      }
    } finally {
      console.log('[startup-usable] native endpoints:', JSON.stringify(reading));
      recordInteractionMs('startup-usable', duration, 4000);
    }
    if (duration === null) throw new Error('native startup instrument unavailable');
    const detail = reading.entries[0].detail as { endedAtEpochMs: number; pageTimeOrigin: number };
    for (const [key, value] of Object.entries({
      'process-entry-epoch-ms': reading.origin!.startedAtEpochMs,
      'usable-epoch-ms': detail.endedAtEpochMs,
      'page-time-origin-ms': detail.pageTimeOrigin,
      'process-id': reading.origin!.pid,
    })) recordMeasure({ key: 'native-startup:' + key, value, unit: 'count', budget: null, ok: true });
    expect(duration).toBeLessThanOrEqual(4000);
  });
});

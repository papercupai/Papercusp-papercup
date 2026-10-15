import type { Page } from '@playwright/test';
import { expect, test } from './_egress';

type ReadingProbe = {
  created: number;
  plays: number;
  produced: number;
  cancelled: boolean;
  mic: number;
  finish(): void;
};
type ProbeWindow = Window & { __readingErrorOutput: ReadingProbe };

// Exercise the normal drawer and player. The output adapter is deliberately
// controlled; real provider synthesis has separate registered verification.
async function openReading(page: Page, mode: 'reject' | 'truncate' | 'backpressure', startReading = true) {
  const prefsPath = '/api/agent-mcp/operator-voice-prefs';
  const beforeResponse = await page.request.get(prefsPath);
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json() as { ttsEngine: string };
  const selected = await page.request.put(prefsPath, { data: { ttsEngine: 'kokoro' } });
  expect(selected.status()).toBe(200);
  const restore = async () => {
    const response = await page.request.put(prefsPath, { data: { ttsEngine: before.ttsEngine } });
    expect(response.status()).toBe(200);
  };
  try {
    await page.addInitScript(mode => {
      sessionStorage.setItem('oracle-tutorial-complete', 'true');
      let ended: (() => void) | undefined;
      const probe: ReadingProbe = {
        created: 0, plays: 0, produced: 0, cancelled: false, mic: 0,
        finish() { const callback = ended; ended = undefined; callback?.(); },
      };
      (window as unknown as ProbeWindow).__readingErrorOutput = probe;
      class ControlledAudio {
        playbackRate = 1;
        currentTime = 0;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() { probe.created++; }
        async play() {
          probe.plays++;
          if (mode === 'reject') throw new Error('Controlled narration playback rejection');
          ended = () => this.onended?.();
        }
        pause() {}
      }
      Object.defineProperty(window, 'Audio', { configurable: true, value: ControlledAudio });
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
        probe.mic++;
        throw new DOMException('Output-only reading must not request a microphone', 'NotAllowedError');
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
        if (path !== '/api/agent-mcp/operator-tts' || init?.method !== 'POST') return originalFetch(input, init);
        const body = JSON.parse(String(init.body));
        if (body.operation !== 'read') return originalFetch(input, init);
        const text = body.text as string;
        const chunks = [text.slice(0, 5), text.slice(5)];
        let index = 0;
        let position = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index === chunks.length || (mode === 'truncate' && index === 1)) {
              if (mode !== 'truncate') controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, type: 'completed', chunks: index }) + '\n'));
              controller.close();
              return;
            }
            const chunk = chunks[index++]!;
            const start = position;
            position += chunk.length;
            probe.produced++;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              ok: true, type: 'chunk', text: chunk, start, end: position,
              audioBase64: 'AQ==', contentType: 'audio/wav',
            }) + '\n'));
          },
          cancel() { probe.cancelled = true; },
        }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/x-ndjson' } });
      };
    }, mode);
    await page.goto('/?chat=true');
    await page.getByRole('button', { name: 'Read selected text aloud' }).click();
    await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill('FIRST SECOND EXACT FINAL TAIL');
    if (startReading) await page.getByRole('button', { name: 'Read selection', exact: true }).click();
    return restore;
  } catch (error) {
    await restore();
    throw error;
  }
}

async function output(page: Page) {
  return page.evaluate(() => {
    const { created, plays, produced, cancelled, mic } = (window as unknown as ProbeWindow).__readingErrorOutput;
    return { created, plays, produced, cancelled, mic };
  });
}

test('rejected narration playback reports an error without an audible-completion receipt', async ({ page }) => {
  const restore = await openReading(page, 'reject');
  try {
    const controls = page.getByRole('group', { name: 'Original reading controls' });
    await expect(controls.getByRole('alert')).toHaveText('Controlled narration playback rejection');
    await expect(controls.getByRole('status')).toHaveText('error · 0%');
    await expect(controls.getByRole('progressbar')).toHaveAttribute('value', '0');
    await expect.poll(async () => (await output(page)).cancelled).toBe(true);
    expect(await output(page)).toMatchObject({ created: 1, plays: 1, produced: 1, mic: 0 });
  } finally { await restore(); }
});

test('a truncated narration stream preserves played progress and reports an error', async ({ page }) => {
  const restore = await openReading(page, 'truncate');
  try {
    await expect.poll(async () => (await output(page)).plays).toBe(1);
    await page.evaluate(() => (window as unknown as ProbeWindow).__readingErrorOutput.finish());
    const controls = page.getByRole('group', { name: 'Original reading controls' });
    await expect(controls.getByRole('alert')).toHaveText('Reading ended before the source was complete.');
    await expect(controls.getByRole('status')).toContainText('error');
    await expect(controls.getByRole('progressbar')).toHaveAttribute('value', '5');
    expect(await output(page)).toMatchObject({ created: 1, plays: 1, produced: 1, mic: 0 });
  } finally { await restore(); }
});

test('stalled narration consumes no further chunks until playback advances', async ({ page }) => {
  const restore = await openReading(page, 'backpressure');
  try {
    await expect.poll(async () => (await output(page)).plays).toBe(1);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await output(page)).toMatchObject({ created: 1, plays: 1, produced: 1, mic: 0 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    expect(await output(page)).toMatchObject({ created: 1, produced: 1 });
    await page.evaluate(() => (window as unknown as ProbeWindow).__readingErrorOutput.finish());
    await expect.poll(async () => (await output(page)).created).toBe(2);
    await expect(page.getByRole('progressbar', { name: 'Reading progress' })).toHaveAttribute('value', '5');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => (await output(page)).cancelled).toBe(true);
    expect(await output(page)).toMatchObject({ created: 2, produced: 2, mic: 0 });
  } finally { await restore(); }
});

test('summary budget failure reports its limit without creating summary text or speech', async ({ page }) => {
  const failure = 'Summary reached its configured spend budget.';
  const turns: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/operator\/conversations\/[^/]+\/turns/.test(request.url())) turns.push(request.url());
  });
  await page.route('**/api/agent-mcp/operator-tts', async route => {
    expect(route.request().postDataJSON().operation).toBe('summarize');
    await route.fulfill({ status: 504, json: { ok: false, code: 'budget-exceeded', error: failure } });
  });
  const restore = await openReading(page, 'backpressure', false);
  try {
    await page.getByRole('button', { name: 'Summarize and read', exact: true }).click();
    await expect(page.getByText(failure, { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Summary', exact: true })).toHaveCount(0);
    expect(await output(page)).toMatchObject({ created: 0, plays: 0, produced: 0, mic: 0 });
    expect(turns).toEqual([]);
  } finally { await restore(); }
});

test('output mute stops active narration and refuses a new reading until unmuted', async ({ page }) => {
  const turns: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/operator\/conversations\/[^/]+\/turns/.test(request.url())) turns.push(request.url());
  });
  const restore = await openReading(page, 'backpressure');
  try {
    await expect.poll(async () => (await output(page)).plays).toBe(1);
    await page.getByRole('button', { name: 'Mute spoken voice replies', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unmute spoken voice replies', exact: true })).toBeVisible();
    await expect.poll(async () => (await output(page)).cancelled).toBe(true);
    await page.getByRole('button', { name: 'Read selected text aloud' }).click();
    const controls = page.getByRole('group', { name: 'Original reading controls' });
    await expect(controls.getByRole('status')).toHaveText('stopped · 0%');
    await page.evaluate(() => (window as unknown as ProbeWindow).__readingErrorOutput.finish());
    await page.getByRole('button', { name: 'Read selection', exact: true }).click();
    await expect(page.getByText('Spoken output is muted. Unmute the speaker to start reading.', { exact: true })).toBeVisible();
    expect(await output(page)).toMatchObject({ created: 1, plays: 1, produced: 1, mic: 0 });
    expect(turns).toEqual([]);
  } finally {
    const unmute = page.getByRole('button', { name: 'Unmute spoken voice replies', exact: true });
    if (await unmute.isVisible()) await unmute.click();
    await restore();
  }
});

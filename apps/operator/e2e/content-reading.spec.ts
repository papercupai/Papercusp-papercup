import type { Page, Route } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, test } from './_egress';

/** Production shell and reading player with controlled output adapters. Real provider
 * synthesis is verified separately; this suite exercises source order, controls,
 * microphone independence and explicit composition without a device or paid call. */
type OutputProbe = {
  created: number; plays: number; pauses: number; resumes: number; mic: number;
  utterances: string[]; cancellations: string[]; finish(): void;
};
type ProbeWindow = Window & { __contentOutput: OutputProbe };

async function openReading(page: Page, workspace?: string) {
  await page.addInitScript(() => {
    sessionStorage.setItem('oracle-tutorial-complete', 'true');
    let finish: (() => void) | undefined;
    const probe: OutputProbe = {
      created: 0, plays: 0, pauses: 0, resumes: 0, mic: 0, utterances: [], cancellations: [],
      finish() { const callback = finish; finish = undefined; callback?.(); },
    };
    (window as unknown as ProbeWindow).__contentOutput = probe;
    class ControlledAudio {
      playbackRate = 1;
      currentTime = 0;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { probe.created++; }
      async play() { probe.plays++; finish = () => this.onended?.(); }
      pause() { probe.pauses++; }
    }
    Object.defineProperty(window, 'Audio', { configurable: true, value: ControlledAudio });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{ name: 'Content fixture local voice', lang: 'en-US', localService: true }],
      speak(utterance: SpeechSynthesisUtterance) {
        probe.created++; probe.plays++; probe.utterances.push(utterance.text);
        finish = () => utterance.onend?.(new Event('end') as SpeechSynthesisEvent);
      },
      pause() { probe.pauses++; }, resume() { probe.resumes++; },
      cancel() { probe.cancellations.push(new Error('Speech cancelled').stack ?? 'unknown caller'); probe.pauses++; finish = undefined; },
    } });
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      probe.mic++;
      throw new DOMException('Output-only reading must not request a microphone', 'NotAllowedError');
    };
  });
  const turnPosts: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/operator\/conversations\/[^/]+\/turns/.test(request.url())) turnPosts.push(request.url());
  });
  await page.goto('/?chat=true' + (workspace ? '&ws=' + encodeURIComponent(workspace) : ''));
  const trigger = page.getByRole('button', { name: 'Read selected text aloud' });
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await trigger.click();
  await expect(page.getByRole('textbox', { name: 'Text to read or summarize' })).toBeVisible();
  return turnPosts;
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  const evidence = await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__contentOutput;
    return { ...probe, readingStatus: document.querySelector('[aria-label="Original reading controls"] [role="status"]')?.textContent };
  });
  await testInfo.attach('controlled-output-diagnostics', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
});

async function output(page: Page) {
  return page.evaluate(() => {
    const { created, plays, pauses, resumes, mic, utterances } = (window as unknown as ProbeWindow).__contentOutput;
    return { created, plays, pauses, resumes, mic, utterances };
  });
}

async function finishOutput(page: Page) {
  await page.evaluate(() => (window as unknown as ProbeWindow).__contentOutput.finish());
}

async function fulfillReading(route: Route, text: string) {
  const records = [];
  for (let start = 0; start < text.length; start += 2000) {
    const chunk = text.slice(start, start + 2000);
    records.push({ type: 'chunk', ok: true, start, end: start + chunk.length,
      text: chunk, contentType: 'audio/wav', audioBase64: 'UklGRg==' });
  }
  records.push({ type: 'completed', ok: true });
  await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: records.map(record => JSON.stringify(record)).join('\n') + '\n' });
}

test('original reading preserves its final tail and pauses/resumes the same output without a microphone', async ({ page }) => {
  const source = 'Authorized source sentence. '.repeat(180) + 'EXACT FINAL TAIL';
  const reads: string[] = [];
  await page.route('**/api/agent-mcp/operator-tts', async route => {
    const body = route.request().postDataJSON();
    expect(body.operation).toBe('read'); reads.push(body.text);
    expect(body.allowCloud).toBe(false);
    await fulfillReading(route, body.text);
  });
  const turns = await openReading(page);
  await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill(source);
  await page.getByRole('button', { name: 'Read selection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect.poll(async () => (await output(page)).plays).toBeGreaterThan(0);
  const before = await output(page);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expect((await output(page)).created).toBe(before.created);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  expect((await output(page)).created).toBe(before.created);
  // Both the stream adapter (2000 chars) and browser adapter (4000 bytes) are
  // controlled at their end event. Every advance waits for the next real output.
  for (let i = 0; i < 4; i++) {
    const progress = page.getByRole('progressbar', { name: 'Reading progress' });
    if (Number(await progress.getAttribute('value')) === source.length) break;
    const created = (await output(page)).created;
    await finishOutput(page);
    await expect.poll(async () => {
      const value = Number(await progress.getAttribute('value'));
      return value === source.length || (await output(page)).created > created;
    }).toBe(true);
  }
  const progress = page.getByRole('progressbar', { name: 'Reading progress' });
  await expect(progress).toHaveAttribute('value', String(source.length));
  const probe = await output(page);
  expect(reads.length ? reads.join('') : probe.utterances.join('')).toBe(source);
  expect(probe.mic).toBe(0); expect(turns).toEqual([]);
});

test('summary-only and summary-and-read keep separate consent and source coverage', async ({ page }) => {
  const source = 'Source with numbers 12 and 34. EXACT FINAL TAIL';
  const summary = 'The source reports 12 and 34.';
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/api/agent-mcp/operator-tts', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (body.operation === 'read') {
      expect(body.text).toBe(summary); expect(body.allowCloud).toBe(false);
      await fulfillReading(route, summary); return;
    }
    expect(body.operation).toBe('summarize');
    expect(body.content).toMatchObject({ kind: 'selection', text: source, partial: true });
    expect(body.summary).toMatchObject({ allowCloud: true, length: 'short', focus: 'numbers', language: 'English' });
    await route.fulfill({ json: { ok: true, summary, coverage: { complete: false, warnings: ['source-partial'] } } });
  });
  const turns = await openReading(page);
  await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill(source);
  await page.getByRole('checkbox', { name: 'Allow this text to use a cloud summary model' }).check();
  await page.getByRole('combobox', { name: 'Summary length' }).click();
  await page.getByRole('option', { name: 'Short', exact: true }).click();
  await page.getByRole('textbox', { name: 'Summary focus' }).fill('numbers');
  await page.getByRole('textbox', { name: 'Summary language' }).fill('English');
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Summary', exact: true })).toContainText(summary);
  await expect(page.getByRole('region', { name: 'Summary', exact: true })).toContainText('source-partial');
  expect((await output(page)).created).toBe(0);
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: 'Summarize and read', exact: true }).click();
  await expect.poll(async () => (await output(page)).plays).toBeGreaterThan(0);
  const probe = await output(page);
  expect(requests.filter(request => request.operation === 'summarize')).toHaveLength(2);
  expect(probe.mic).toBe(0); expect(turns).toEqual([]);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await finishOutput(page);
  await expect(page.getByRole('button', { name: 'Read selection', exact: true })).toBeEnabled();
});

test('cancel summary ignores a late result and cannot start obsolete speech', async ({ page }) => {
  let release!: () => void;
  let received!: () => void;
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  const responseReleased = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/agent-mcp/operator-tts', async route => {
    received(); await responseReleased;
    await route.fulfill({ json: { ok: true, summary: 'Late obsolete summary', coverage: { complete: true, warnings: [] } } }).catch(() => {});
  });
  await openReading(page);
  await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill('Authorized text.');
  await page.getByRole('button', { name: 'Summarize and read', exact: true }).click();
  await requestReceived;
  await page.getByRole('button', { name: 'Cancel summary', exact: true }).click();
  release();
  await expect(page.getByRole('button', { name: 'Summarize', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Summary', exact: true })).toHaveCount(0);
  expect((await output(page)).created).toBe(0);
});

test('global speech cancellation stops active narration and suppresses its queued final tail', async ({ page }) => {
  await page.addInitScript(() => {
    // Reuse the existing desktop verification seam; cancel calls the production
    // cancelAllSpeech entry used by barge-in, rather than reading-scoped Stop.
    (window as Window & { __PAPERCUSP_DEV_WRAPPER__?: boolean }).__PAPERCUSP_DEV_WRAPPER__ = true;
  });
  await page.route('**/api/agent-mcp/operator-tts', async route => {
    const body = route.request().postDataJSON();
    expect(body.operation).toBe('read');
    await fulfillReading(route, body.text);
  });
  const turns = await openReading(page);
  const source = 'Active narration with a queued continuation. '.repeat(130) + 'CANCELLED FINAL TAIL';
  await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill(source);
  await page.getByRole('button', { name: 'Read selection', exact: true }).click();
  await expect.poll(async () => (await output(page)).plays).toBe(1);
  const before = await output(page);
  await page.evaluate(() => {
    const voice = (window as Window & { __pcVoiceTest?: { cancel(): void } }).__pcVoiceTest;
    if (!voice) throw new Error('Production global speech cancellation seam is unavailable');
    voice.cancel();
  });
  await expect(page.getByRole('group', { name: 'Original reading controls' }).getByRole('status')).toHaveText('stopped · 0%');
  // A late end event from the cancelled output must not advance the old queue.
  await finishOutput(page);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const cancelled = await output(page);
  expect(cancelled.created).toBe(before.created);
  expect(cancelled.plays).toBe(before.plays);
  expect(cancelled.pauses).toBeGreaterThan(before.pauses);
  await expect(page.getByRole('progressbar', { name: 'Reading progress' })).toHaveAttribute('value', '0');
  expect(cancelled.utterances.join('')).not.toContain('CANCELLED FINAL TAIL');
  expect(cancelled.mic).toBe(0);
  expect(turns).toEqual([]);
  // Cancellation must also leave the ordinary player usable for fresh content.
  await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill('Fresh narration after cancellation.');
  await page.getByRole('button', { name: 'Read selection', exact: true }).click();
  await expect.poll(async () => (await output(page)).plays).toBe(before.plays + 1);
  await finishOutput(page);
  await expect(page.getByRole('group', { name: 'Original reading controls' }).getByRole('status')).toHaveText('completed · 100%');
});

test('summary failure is visible and never becomes summary text or speech', async ({ page }) => {
  await page.route('**/api/agent-mcp/operator-tts', route => route.fulfill({ status: 403, json: { ok: false, error: 'Cloud summary requires explicit consent.' } }));
  await openReading(page);
  await page.getByRole('textbox', { name: 'Text to read or summarize' }).fill('Private source.');
  await page.getByRole('button', { name: 'Summarize and read', exact: true }).click();
  await expect(page.getByText('Cloud summary requires explicit consent.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Summary', exact: true })).toHaveCount(0);
  expect((await output(page)).created).toBe(0);
});

test('signed ordinary-agent narration returns a requesting-tab receipt and controls only output in that tab', async ({ page, context, request, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  const parent = process.env.PAPERCUSP_SID;
  test.skip(!workspace || !parent || !process.env.PAPERCUSP_TEST_RUN_WORK_ITEM_ID,
    'The authenticated current-build journey requires a workspace, author session and held work-item.');
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(baseURL!).hostname);
  const bystander = await context.newPage();
  const source = 'AUTHORIZED AGENT NARRATION ' + randomUUID() + ' EXACT FINAL TAIL';
  const reads: string[] = [];
  const bystanderReads: string[] = [];
  for (const [tab, captured] of [[page, reads], [bystander, bystanderReads]] as const) {
    await tab.route('**/api/agent-mcp/operator-tts', async route => {
      const body = route.request().postDataJSON();
      expect(body.operation).toBe('read');
      expect(body.allowCloud).toBe(false);
      captured.push(body.text);
      await fulfillReading(route, body.text);
    });
  }
  try {
    // Give the normal browser factory its own UUIDs; no callerSid impersonation
    // or forged superuser context. Reuse the maintained spawn signer to mint
    // short-lived ordinary Papercup fixtures bound to those requesting tabs.
    await openReading(page, workspace!);
    await openReading(bystander, workspace!);
    await page.bringToFront();
    const client = await page.evaluate(() => sessionStorage.getItem('papercusp_ui_client_id'));
    const otherClient = await bystander.evaluate(() => sessionStorage.getItem('papercusp_ui_client_id'));
    expect(client).toMatch(/^[0-9a-f-]{36}$/i);
    expect(otherClient).not.toBe(client);
    const mint = async (tabClient: string) => {
      const script = "const {signSpawnParams}=await import('./packages/operator-core/lib/spawn-signing.ts');\n"
        + 'const params=new URLSearchParams(JSON.parse(process.argv[1]));\n'
        + 'await signSpawnParams(params,{ttlSec:300});\n'
        + 'process.stdout.write(params.toString());process.exit(0);';
      const { stdout } = await promisify(execFile)(process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify({
          workspace, harness: 'papercusp', role: 'papercup', client: tabClient,
          spawn: 'content-reading-e2e-' + randomUUID(), run: randomUUID(), parent_spawn: parent,
        })], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 30_000, maxBuffer: 64 * 1024 });
      return new URL('/api/mcp?' + stdout.trim(), baseURL!).href;
    };
    let sequence = 0;
    const rpc = async (url: string, method: string, params: Record<string, unknown>) => {
      const id = ++sequence;
      const response = await request.post(url, { headers: {
        'content-type': 'application/json', Accept: 'application/json, text/event-stream',
      }, data: { jsonrpc: '2.0', id, method, params }, timeout: 15_000 });
      expect(response.status()).toBe(200);
      const text = await response.text();
      const body = response.headers()['content-type']?.includes('text/event-stream')
        ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(value => value.id === id)
        : JSON.parse(text);
      expect(body?.id).toBe(id);
      return body;
    };
    const url = await mint(client!);
    const catalog = await rpc(url, 'tools/list', {});
    expect(catalog.error).toBeUndefined();
    const tool = catalog.result.tools.find((entry: { name: string }) => entry.name === 'voice:say');
    expect(tool?.description).toContain('read original authorized content');
    expect(tool.description).toContain('requesting app tab');
    expect(JSON.stringify(tool.inputSchema)).toContain('control');
    const call = async (endpoint: string, args: Record<string, unknown>) => rpc(endpoint, 'tools/call', { name: 'voice:say', arguments: args });
    const content = (body: { result: { content: Array<{ type: string; text: string }> } }) =>
      JSON.parse(body.result.content.find(part => part.type === 'text')!.text);
    const beforeOther = await output(bystander);
    const started = await call(url, { operation: 'read', content: { kind: 'text', text: source } });
    expect(started.error).toBeUndefined();
    expect(started.result.isError).not.toBe(true);
    const receipt = content(started);
    expect(receipt).toMatchObject({ status: 'done', result: { status: 'starting', readingId: expect.any(String) } });
    expect(started.result.structuredContent.destination).toBe(client);
    await expect.poll(async () => (await output(page)).plays).toBeGreaterThan(0);
    const readingId = receipt.result.readingId;
    const created = (await output(page)).created;
    for (const [action, status] of [['pause', 'paused'], ['status', 'paused'], ['resume', 'playing'], ['stop', 'stopped']]) {
      expect(content(await call(url, { operation: 'control', readingId, action }))).toMatchObject({ status: 'done', result: { readingId, status } });
      expect((await output(page)).created).toBe(created);
    }
    const absent = await call(await mint(randomUUID()), { operation: 'read', content: { kind: 'text', text: source } });
    expect(content(absent)).toMatchObject({ ok: false, error: 'destination_unavailable' });
    const tampered = new URL(url);
    tampered.searchParams.set('client', otherClient!);
    const unauthorized = await call(tampered.href, { operation: 'read', content: { kind: 'text', text: source } });
    expect(JSON.stringify(unauthorized)).toContain('invalid_signature');
    const probe = await output(page);
    expect(reads.length ? reads.join('') : probe.utterances.join('')).toBe(source);
    expect(probe.mic).toBe(0);
    expect(await output(bystander)).toEqual(beforeOther);
    expect(bystanderReads).toEqual([]);
    await testInfo.attach('requesting-tab-receipt', { contentType: 'application/json', body: JSON.stringify({
      workspace, client, otherClient, receipt, output: probe, bystanderOutput: beforeOther,
      absent: content(absent), unauthorized: 'invalid_signature',
    }) });
  } finally {
    await bystander.close();
  }
});

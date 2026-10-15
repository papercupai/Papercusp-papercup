import { expect, test } from './_egress';
import {
  FAKE_MIC_LAUNCH_ARGS,
  assertLiveVoiceWhenRequired,
  norm,
  prepareLiveVoiceFixtures,
  withLocalEnginePrefs,
} from './_voice-live';

/**
 * LIVE voice E2E through a real browser (voice-thorough-test-2026-07-09, WI-3527).
 *
 * The sibling `voice-mode.spec.ts` deliberately avoids audio: "headless Chromium
 * can't reliably exercise the SpeechRecognition / SpeechSynthesis APIs (no real
 * mic)". That is true of the *browser speech* APIs — but it is NOT true of the
 * capture pipeline. Chrome will happily play a WAV file into `getUserMedia` via
 * `--use-file-for-fake-audio-capture`, which lets us drive the ACTUAL stack:
 *
 *     kokoro TTS  →  a .wav  →  Chrome's fake mic  →  getUserMedia
 *                 →  MediaRecorder (webm/opus)     →  POST /api/agent-mcp/operator-stt
 *                 →  whisper                       →  a transcript we can assert on
 *
 * That closes the last untested gap: every other TTS/STT test in the tree stubs
 * `fetch`, so they prove the wiring but would stay green if kokoro's or
 * whisper's real API changed. This spec speaks a known sentence and demands to
 * hear it back, through the browser, end to end.
 *
 * Requires a provisioned local Kokoro service (:8880) and an operator whose
 * voice-engine-health route reports a usable Whisper capability. The operator
 * route is intentional here: P-003 retires the broken per-user Whisper unit and
 * may serve STT through the managed whisper-server child on a dynamic port, so
 * this test must not assume the historical :2022 compatibility port. By default,
 * an unavailable capability skips the describe so ordinary CI stays green without
 * local model services. Release acceptance MUST set
 * `PAPERCUSP_REQUIRE_LIVE_VOICE=1`, which turns that skip into a collection
 * failure so a dead or starved local engine cannot produce a false-green gate.
 * Run against a server that serves the voice API routes, e.g.:
 *
 *   OPERATOR_E2E_REUSE_SERVER=1 OPERATOR_E2E_BASE_URL=http://127.0.0.1:3170 \
 *     npx playwright test e2e/voice-live-e2e.spec.ts
 *
 * The fixtures (Kokoro fake-mic WAV, operator engine-health preflight, prefs
 * pinning) live in ./_voice-live.ts, shared with voice-synthetic-roundtrip.spec.ts.
 */

const live = prepareLiveVoiceFixtures();
assertLiveVoiceWhenRequired(live);

// Must be top-level: `launchOptions` forces a new worker, so Playwright forbids
// it inside a describe group. Chrome plays the fake-mic WAV into getUserMedia.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: FAKE_MIC_LAUNCH_ARGS },
});

(live ? test.describe : test.describe.skip)('LIVE voice E2E (real browser, real kokoro + whisper)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('oracle-tutorial-complete', 'true'));
  });

  test('ROUND TRIP: browser mic captures kokoro speech → operator-stt → whisper transcribes it', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/settings/voice', { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async () => {
      // The real capture stack: getUserMedia → MediaRecorder → webm/opus.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const label = stream.getAudioTracks()[0]?.label ?? '';
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start();
      await new Promise((r) => setTimeout(r, 4000));
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());

      const blob = new Blob(chunks, { type: 'audio/webm' });
      const audioBase64 = await new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1]);
        fr.readAsDataURL(blob);
      });

      const r = await fetch('/api/agent-mcp/operator-stt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audioBase64, format: 'webm' }),
      });
      return { label, bytes: blob.size, status: r.status, body: await r.json().catch(() => null) };
    });

    // Sanity: we really captured from the injected file, not a silent null device.
    expect(result.label).toContain('Fake');
    expect(result.bytes).toBeGreaterThan(1_000);
    expect(result.status).toBe(200);
    expect(result.body?.ok).toBe(true);

    // The whole point: the sentence survives TTS → mic → encode → STT.
    const heard = norm(String(result.body?.text ?? ''));
    expect(heard, `whisper heard: ${JSON.stringify(result.body?.text)}`).toContain('quick brown fox');
    expect(heard).toContain('lazy dog');
  });

  test('kokoro preview returns real, playable WAV audio to the page', async ({ page }) => {
    await page.goto('/settings/voice', { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/agent-mcp/operator-tts-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'kokoro', text: 'preview check' }),
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      return {
        status: res.status,
        ct: res.headers.get('content-type'),
        bytes: buf.byteLength,
        riff: String.fromCharCode(...buf.slice(0, 4)),
      };
    });
    expect(r.status).toBe(200);
    expect(r.ct).toBe('audio/wav');
    expect(r.riff).toBe('RIFF');
    expect(r.bytes).toBeGreaterThan(10_000);
  });

  test('a rejected cloud key is classified (401/404) and never masked as a 502 outage', async ({ page }) => {
    // Regression guard for WI-3527: `synthesize()` used to flatten EVERY upstream
    // non-ok onto 502, so a defunded/invalid ElevenLabs key ("fix your key")
    // was indistinguishable from a provider outage ("wait it out"). Whether a
    // key is configured on this box or not, the one status we must NEVER see
    // for a credential problem is 502.
    await page.goto('/settings/voice', { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/agent-mcp/operator-tts-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'elevenlabs', text: 'key check' }),
      });
      return { status: res.status, text: await res.text() };
    });
    expect(r.status).not.toBe(502);
    // 404 'no-key' = none configured; 401 = configured but rejected / out of credits;
    // 400 = the engine is refused by the release-availability seam
    // (voice-release-availability.ts, plan voice-final-public-release-2026-10-01
    // D-005) before any provider call — still a clean, classified 4xx.
    expect([400, 401, 404, 200]).toContain(r.status);
    if (r.status === 404) expect(r.text).toBe('no-key');
    if (r.status === 400) expect(r.text).toContain('not available in this release');
  });

  test('settings UI exposes all 5 TTS engines and the local defaults are selected', async ({ page }) => {
    await withLocalEnginePrefs(page, async () => {
      await page.goto('/settings/voice');
      await expect(page.getByText('Loading your voice settings')).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole('combobox', { name: 'Full-agent engine' })).toBeVisible({ timeout: 60_000 });

      const tts = page.getByRole('combobox', { name: 'TTS engine' });
      await expect(tts).toBeEnabled({ timeout: 20_000 });
      await expect(tts).toContainText('Kokoro');
      await expect(page.getByRole('combobox', { name: 'STT engine' })).toContainText('Voicemode');

      await tts.click();
      for (const name of [/Kokoro/, /Browser/, /ElevenLabs/, /OpenAI/, /Cartesia/]) {
        await expect(page.getByRole('option', { name })).toBeVisible();
      }
      await page.keyboard.press('Escape');
    });
  });

  test('the UI preview button really synthesizes through the local engine', async ({ page }) => {
    await withLocalEnginePrefs(page, async () => {
      await page.goto('/settings/voice');
      await expect(page.getByText('Loading your voice settings')).toBeHidden({ timeout: 60_000 });
      await expect(page.getByRole('combobox', { name: 'Full-agent engine' })).toBeVisible({ timeout: 60_000 });

      const preview = page.getByRole('button', { name: /Preview kokoro/i });
      await expect(preview).toBeEnabled({ timeout: 20_000 });

      const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/operator-tts-preview'), { timeout: 45_000 }),
        preview.click(),
      ]);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toBe('audio/wav');
      // Assert the SIZE via content-length, not `response.body()`. The preview is
      // played by an <audio> element, so Chrome streams it as a media resource and
      // Playwright cannot buffer the body — `body()` comes back empty (0 bytes)
      // even though the route really did return ~50KB of WAV.
      expect(Number(response.headers()['content-length'])).toBeGreaterThan(10_000);
    });
  });
});

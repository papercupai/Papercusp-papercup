/**
 * Guard: every live `Conversation.startSession()` call site must pin
 * `connectionType: 'webrtc'`, except the tutorial's explicit websocket seam
 * which pins all three local audio assets. Both avoid the SDK's CDN default.
 *
 * WI-7116 (egress-monitor-origin-axis-2026-08-02 P-004 static scan). The scan
 * found `https://cdn.jsdelivr.net/npm/@alexanderolsen/libsamplerate-js@2.1.2/
 * dist/libsamplerate.worklet.js` in the shipped bundle — `@elevenlabs/client`'s
 * `addLibsamplerateModule()` (node_modules/@elevenlabs/client/dist/utils/
 * addLibsamplerateModule.js) hardcodes it as the default AudioWorklet source
 * for its resampling fallback.
 *
 * PER D-004 (cdn-egress-fixes-2026-08-02): a bundle string is a discovery,
 * never a verdict. Read all the way down: `addLibsamplerateModule` is only
 * ever called from `setupInputOutput()` (node_modules/@elevenlabs/client/dist/
 * lib.iife.js), which branches on `connection instanceof WebRTCConnection` vs
 * `WebSocketConnection` — the WebRTC branch returns the LiveKit-native
 * `connection.input`/`connection.output` directly and NEVER constructs a
 * `MediaDeviceInput`/`MediaDeviceOutput` (the only callers of
 * `addLibsamplerateModule`). The SDK resolves `connectionType` ONCE, from our
 * own passed config, with no runtime fallback between the two — so which
 * branch runs is entirely decided by the literal our own call sites pass, not
 * by anything at runtime.
 *
 * THE FAILURE MODE THIS GUARDS: `connectionType` is OPTIONAL with a
 * conditional default (`config.textOnly ? 'websocket' : 'webrtc'` — see the
 * SDK's own `resolveConnectionType`), so a new call site that drops the
 * explicit 'webrtc', or an existing one edited to omit it, does not throw —
 * it silently starts resolving to 'websocket' under some configs and quietly
 * reintroduces the jsdelivr fetch on first resample. Exactly the class of bug
 * monaco-cdn.test.ts / vditor-cdn.test.ts guard for their own libraries.
 *
 * Tutorial voice now needs websocket signed URLs. Its single named exception
 * must pin libsampleratePath and both workletPaths; all other launches remain
 * WebRTC. setup-elevenlabs-runtime.mjs prepares the maintained local assets.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listLiveTypeScriptFiles } from './live-source-files';
import { stripJsComments } from './strip-js-comments';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

const CONNECTION_TYPE_WEBRTC = /connectionType:\s*['"]webrtc['"]/;

/** Real, live call sites — excludes tests (which mock the module) and the
 *  retired web app under libs/papercusp/_retired (guarded by lint:no-retired). */
async function liveStartSessionCallSites(): Promise<string[]> {
  const candidates = (await listLiveTypeScriptFiles(REPO_ROOT))
    .filter(Boolean)
    .filter((f) => !f.includes('.test.'))
    .filter((f) => !f.includes('_retired/'));

  const sites: string[] = [];
  for (const file of candidates) {
    const code = stripJsComments(await readFile(resolve(REPO_ROOT, file), 'utf8'));
    if (/Conversation\.startSession\(/.test(code)) sites.push(file);
  }
  return sites.sort();
}

describe('elevenlabs-conv libsamplerate cdn (WI-7116)', () => {
  it('every live SDK launch pins WebRTC or the tutorial local websocket assets', async () => {
    const sites = await liveStartSessionCallSites();

    // Two today: the production conv-voice engine and the /el-min diagnostic
    // page. Both must stay pinned — see the module header for why 'webrtc' is
    // the invariant that makes the jsdelivr fetch dead code.
    expect(sites.length).toBeGreaterThanOrEqual(2);

    const notPinned: string[] = [];
    for (const file of sites) {
      const code = stripJsComments(await readFile(resolve(REPO_ROOT, file), 'utf8'));
      if (file === 'apps/operator/lib/onboarding/tutorial-voice-client.ts') {
        expect(code).toMatch(/connectionType:\s*'websocket'/);
        for (const asset of ['rawAudioProcessor.js', 'audioConcatProcessor.js', 'libsamplerate.worklet.js']) {
          expect(code).toContain('/elevenlabs-runtime/' + asset);
        }
        expect(code).toMatch(/workletPaths:\s*\{\s*\.\.\.workletPaths\s*\}/);
        expect(code).toMatch(/libsampleratePath,/);
      } else if (!CONNECTION_TYPE_WEBRTC.test(code)) notPinned.push(file);
    }

    // Named, not counted: the failure has to say WHICH surface stopped
    // pinning webrtc, or the next person has to re-derive it from a bare
    // "expected 2 to be 0".
    expect(
      notPinned,
      `Conversation.startSession call sites not pinned to connectionType:'webrtc' ` +
        `(risk of resolving to 'websocket' and reintroducing the jsdelivr libsamplerate ` +
        `fetch — see this file's header): ${notPinned.join(', ')}`,
    ).toEqual([]);
  });

  it('addLibsamplerateModule is only reachable from the websocket connection branch', async () => {
    // Pins the SDK-internal fact the guard above depends on, so a
    // `@elevenlabs/client` version bump that changes this dispatch fails HERE
    // — loudly, with an explanation — instead of silently invalidating the
    // reasoning in the test above.
    const sdkPath = resolve(REPO_ROOT, 'node_modules/@elevenlabs/client/dist/lib.iife.js');
    const src = await readFile(sdkPath, 'utf8');

    // setupInputOutput() short-circuits for WebRTCConnection (returns
    // connection.input/output directly, never touching MediaDeviceInput/
    // Output — the only callers of addLibsamplerateModule) and only
    // constructs MediaDeviceInput/Output — which thread libsampleratePath —
    // inside the WebSocketConnection branch.
    const setupInputOutputMatch = src.match(
      /async function setupInputOutput\([^)]*\)\s*\{[\s\S]*?\n\t\}/,
    );
    expect(setupInputOutputMatch, 'setupInputOutput() not found — @elevenlabs/client internals changed shape, re-derive this guard').toBeTruthy();
    const body = setupInputOutputMatch![0];

    expect(body).toMatch(/connection instanceof WebRTCConnection/);
    expect(body).toMatch(/connection instanceof WebSocketConnection/);
    expect(body).toMatch(/MediaDeviceInput\.create/);
    expect(body).toMatch(/libsampleratePath/);
  });
});

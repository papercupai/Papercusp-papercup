/** Run through verify-tauri-headless and the maintained runNativeE2e driver. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeEval } from '../../../../libs/generic/tauri-verify/src/bridge-client';

const names = ['rawAudioProcessor.js', 'audioConcatProcessor.js', 'libsamplerate.worklet.js'];
describe.skipIf(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1')('tutorial voice assets in native Tauri', () => {
  it('serves the exact frozen worklet bytes as JavaScript and rejects a missing asset', async () => {
    const profile = JSON.parse(readFileSync(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!, 'utf8'));
    const pid = Number(process.env.VERIFY_TAURI_PID);
    expect(profile.tauriPID).toBe(pid);
    const token = JSON.parse(readFileSync(join(profile.nativeTmpDir, `tauri-dev-bridge-${pid}.token`), 'utf8'));
    expect(token.pid).toBe(pid);
    const config = { tauriPID: pid, bridgePort: token.port, bridgeToken: token.token };
    const evaluate = async (js: string) => {
      const result = await bridgeEval<any>(config, js);
      expect(result.ok, result.ok ? undefined : result.error).toBe(true);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    };
    expect(await evaluate('Boolean(window.__TAURI_INTERNALS__)')).toBe(true);
    const paths = [...names.map(name => `/elevenlabs-runtime/${name}`), '/elevenlabs-runtime/missing-native-acceptance.js'];
    await evaluate(`window.__tutorialAssetAcceptance = null; void (async () => {
      try {
        const rows = await Promise.all(${JSON.stringify(paths)}.map(async path => {
          const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
          const bytes = new Uint8Array(await response.arrayBuffer());
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          return { path, status: response.status, type: response.headers.get('content-type'),
            sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') };
        }));
        window.__tutorialAssetAcceptance = { rows };
      } catch (error) { window.__tutorialAssetAcceptance = { error: String(error) }; }
    })()`);
    let result: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await evaluate('window.__tutorialAssetAcceptance');
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(result?.error).toBeUndefined();
    expect(result?.rows).toHaveLength(paths.length);
    for (const [index, name] of names.entries()) {
      const row = result.rows[index];
      expect(row.status).toBe(200);
      expect(row.type).toMatch(/^(?:text|application)\/javascript(?:;|$)/i);
      const frozen = readFileSync(join(process.env.VERIFY_TAURI_SPA_DIST!, 'elevenlabs-runtime', name));
      expect(row.sha256).toBe(createHash('sha256').update(frozen).digest('hex'));
    }
    expect(result.rows[3].status).toBe(404);
    console.log(`TUTORIAL_VOICE_NATIVE_ASSETS=${JSON.stringify(result.rows)}`);
  }, 30_000);
});

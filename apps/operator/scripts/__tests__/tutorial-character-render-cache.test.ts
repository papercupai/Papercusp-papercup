import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch } }));
vi.mock('@papercusp/operator-core/lib/voice-prefs', () => ({ loadVoicePrefs: async () => ({ elevenlabsVoiceId: 'cache-test-voice' }) }));
// @ts-ignore — pure JS CLI, intentionally untyped in this regression (EI-26730317493759239).
import { characterRenderKey, renderPreview } from '../tutorial-character-preview.mjs';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const text = 'a';
const options = { text, width: 384, height: 216, transparent: true };
const alignment = { characters: ['a'], character_start_times_seconds: [0], character_end_times_seconds: [1] };
const audio = Buffer.from('original narration bytes');
let outDir: string;

async function cacheInputs() {
  return {
    narrationHash: sha(JSON.stringify({ text, voiceId: 'cache-test-voice', model: 'eleven_turbo_v2_5' })),
    duration: 1.4, width: options.width, height: options.height, transparent: options.transparent,
    svg: await readFile(new URL('../../public/tutorial-character.svg', import.meta.url), 'utf8'),
    renderer: await readFile(new URL('../tutorial-character-preview.mjs', import.meta.url), 'utf8'),
    model: await readFile(new URL('../tutorial-character-model.mjs', import.meta.url), 'utf8'),
    alignment, audioSha256: sha(audio),
  };
}

beforeEach(async () => {
  launch.mockReset().mockRejectedValue(new Error('cache miss reached the renderer'));
  outDir = await mkdtemp(join(tmpdir(), 'tutorial-render-cache-'));
  const inputs = await cacheInputs();
  const video = Buffer.from('previously rendered character');
  await Promise.all([
    writeFile(join(outDir, 'narration.mp3'), audio),
    writeFile(join(outDir, 'alignment.json'), JSON.stringify(alignment)),
    writeFile(join(outDir, 'narration-receipt.json'), JSON.stringify({ narrationHash: inputs.narrationHash })),
    writeFile(join(outDir, 'papercup-character.mov'), video),
    writeFile(join(outDir, 'character-render-receipt.json'), JSON.stringify({ renderHash: characterRenderKey(inputs), videoSha256: sha(video) })),
  ]);
});
afterEach(async () => { await rm(outDir, { recursive: true, force: true }); });

describe('character render cache input identity', () => {
  it('reuses identical narration and render inputs without launching a renderer', async () => {
    await expect(renderPreview({ outDir, ...options })).resolves.toMatchObject({ cached: true });
    expect(launch).not.toHaveBeenCalled();
  });
  it('rerenders when mouth timing changes without changing the chapter duration or text', async () => {
    await writeFile(join(outDir, 'alignment.json'), JSON.stringify({ ...alignment, character_start_times_seconds: [.5] }));
    await expect(renderPreview({ outDir, ...options })).rejects.toThrow('cache miss reached the renderer');
    expect(launch).toHaveBeenCalledOnce();
  });
  it('rerenders when the actual narration audio changes under the same synthesis recipe', async () => {
    await writeFile(join(outDir, 'narration.mp3'), Buffer.from('replacement narration bytes'));
    await expect(renderPreview({ outDir, ...options })).rejects.toThrow('cache miss reached the renderer');
    expect(launch).toHaveBeenCalledOnce();
  });
  it('invalidates a changed animation model even when the calling renderer stays the same', async () => {
    const inputs = await cacheInputs();
    expect(characterRenderKey({ ...inputs, model: inputs.model.replace("return 'round'", "return 'closed'") })).not.toBe(characterRenderKey(inputs));
  });
  it('rerenders a corrupted cached video even when all input identities match', async () => {
    await writeFile(join(outDir, 'papercup-character.mov'), Buffer.from('corrupt video'));
    await expect(renderPreview({ outDir, ...options })).rejects.toThrow('cache miss reached the renderer');
  });
});

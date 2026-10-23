#!/usr/bin/env node
/** Render a short speech-synchronised PaperCup preview using ElevenLabs alignment. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { pageHtml } from './tutorial-character-model.mjs';

export const PREVIEW_TEXT = "Hi, I'm PaperCup, the operator of Papercusp. I'll guide you through your first project.";
const FPS = 24;

export function characterRenderKey({ narrationHash, audioSha256, alignment, duration, width, height, transparent, svg, renderer, model }) {
  return createHash('sha256').update(JSON.stringify({ narrationHash, audioSha256, alignment, duration, width, height, transparent, fps: FPS, svg, renderer, model })).digest('hex');
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

async function synthesize(text, voiceId) {
  const { readElevenLabsKey } = await import('@papercusp/operator-core/lib/voice-credentials');
  const key = await readElevenLabsKey(); if (!key) throw new Error('ElevenLabs key is not configured');
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }) });
  if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json(); return { audio: Buffer.from(payload.audio_base64, 'base64'), alignment: payload.alignment };
}


export async function prepareNarration({ outDir, text = PREVIEW_TEXT } = {}) {
  if (!outDir || !text?.trim()) throw new Error('outDir and nonempty text are required');
  await mkdir(outDir, { recursive: true });
  const { loadVoicePrefs } = await import('@papercusp/operator-core/lib/voice-prefs');
  const prefs = await loadVoicePrefs();
  const narrationHash = createHash('sha256').update(JSON.stringify({ text, voiceId: prefs.elevenlabsVoiceId, model: 'eleven_turbo_v2_5' })).digest('hex');
  let audio, alignment;
  try { const receipt = JSON.parse(await readFile(join(outDir, 'narration-receipt.json'), 'utf8')); if (receipt.narrationHash !== narrationHash) throw Object.assign(new Error('Narration changed'), { code: 'ENOENT' }); audio = await readFile(join(outDir, 'narration.mp3')); alignment = JSON.parse(await readFile(join(outDir, 'alignment.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ({ audio, alignment } = await synthesize(text, prefs.elevenlabsVoiceId)); }
  await writeFile(join(outDir, 'narration.mp3'), audio);
  await writeFile(join(outDir, 'alignment.json'), JSON.stringify(alignment));
  await writeFile(join(outDir, 'narration-receipt.json'), JSON.stringify({ narrationHash, voiceId: prefs.elevenlabsVoiceId, provider: 'elevenlabs', text }));
  const ends = alignment?.character_end_times_seconds ?? [];
  if (!alignment?.characters?.length || alignment.characters.length !== ends.length || ends.some(value => !Number.isFinite(value))) throw new Error('Narration alignment is missing or invalid');
  return { audioPath: join(outDir, 'narration.mp3'), audioSha256: createHash('sha256').update(audio).digest('hex'), alignment, duration: Math.max(1, ends.at(-1) + 0.4), narrationHash };
}

export async function renderPreview({ outDir, text = PREVIEW_TEXT, width = 960, height = 540, transparent = false, durationSeconds } = {}) {
  if (!outDir) throw new Error('outDir is required');
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 1920)) throw new Error('Invalid character dimensions');
  const { alignment, duration: speechDuration, narrationHash, audioSha256 } = await prepareNarration({ outDir, text });
  const duration = Math.max(speechDuration, durationSeconds ?? 0);
  if (!Number.isFinite(duration) || duration > 1800) throw new Error('Invalid character duration');
  const svg = await readFile(new URL('../public/tutorial-character.svg', import.meta.url), 'utf8');
  const video = join(outDir, transparent ? 'papercup-character.mov' : 'papercup-speaking-preview.mp4');
  const renderHash = characterRenderKey({ narrationHash, audioSha256, alignment, duration, width, height, transparent, svg,
    renderer: await readFile(new URL(import.meta.url), 'utf8'), model: await readFile(new URL('./tutorial-character-model.mjs', import.meta.url), 'utf8') });
  try {
    const receipt = JSON.parse(await readFile(join(outDir, 'character-render-receipt.json'), 'utf8'));
    if (receipt.renderHash === renderHash && receipt.videoSha256 === createHash('sha256').update(await readFile(video)).digest('hex')) return { outDir, video, duration, alignmentCharacters: alignment.characters.length, cached: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const framesDir = await mkdtemp(join(outDir, 'frames-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(svg, alignment, duration, { width, height, transparent }));
    for (let frame = 0; frame < Math.ceil(duration * FPS); frame += 1) {
      await page.evaluate(async t => {
        window.setTime(t);
        // Capture a painted pose, rather than racing the first compositor frame.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, frame / FPS);
      try { await page.screenshot({ path: join(framesDir, `frame-${String(frame).padStart(5, '0')}.png`), omitBackground: transparent }); }
      catch (error) { throw new Error(`Character capture failed at frame ${frame}/${Math.ceil(duration * FPS)}: ${error.message}`); }
    }
  } finally { await browser.close(); }
  await run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', join(framesDir, 'frame-%05d.png'), '-i', join(outDir, 'narration.mp3'), '-c:v', transparent ? 'qtrle' : 'libx264', '-pix_fmt', transparent ? 'argb' : 'yuv420p', '-c:a', 'aac', '-af', `apad=pad_dur=${duration}`, '-t', String(duration), '-movflags', '+faststart', video]);
  await writeFile(join(outDir, 'character-render-receipt.json'), JSON.stringify({ renderHash, videoSha256: createHash('sha256').update(await readFile(video)).digest('hex'), duration, width, height, transparent }));
  return { outDir, video, duration, alignmentCharacters: alignment?.characters?.length ?? 0 };
}

if (isCliEntry(import.meta.url)) { const i = process.argv.indexOf('--out'); const outDir = i >= 0 ? process.argv[i + 1] : '/tmp/papercup-speaking-preview'; renderPreview({ outDir }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; }); }

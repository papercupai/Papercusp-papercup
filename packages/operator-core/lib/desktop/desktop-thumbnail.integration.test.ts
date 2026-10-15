/**
 * The REAL grab path (plan agent-multi-desktops-grid-2026-10-06, P-005 / SPEC-P-005):
 * a throwaway Xvfb painted a known colour, then `grabX11Frame` through real ffmpeg.
 *
 * WHY an integration test: every unit test injects the grab, so none of them can see
 * the ffmpeg argument list go wrong — a wrong input spec, a scale filter that keeps the
 * full size, or an output format that is not a JPEG all still "work" against a stub.
 * Here the frame is decoded back and its size and colour asserted.
 *
 * The Xvfb is spawned on a display Xvfb picks itself (`-displayfd`), so this can never
 * collide with — or read — the owner's live session or a peer's verify display.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTextCollector } from '../child-output';
import { createDesktopThumbnailer, grabX11Frame } from './desktop-thumbnail';

const run = promisify(execFile);
const haveTools = ['/usr/bin/Xvfb', '/usr/bin/ffmpeg', '/usr/bin/xsetroot'].every((p) => existsSync(p));

let xvfb: ChildProcess | null = null;
let display = -1;

function startXvfb(): Promise<number> {
  return new Promise((resolve, reject) => {
    // -noreset: without it Xvfb regenerates (back to a black root) the moment its last
    // client disconnects, so the colour xsetroot paints is gone before ffmpeg connects.
    const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '640x480x24', '-nolisten', 'tcp', '-noreset'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    xvfb = child;
    const displayFd = child.stdio[3] as NodeJS.ReadableStream;
    const out = createTextCollector(displayFd);
    const timer = setTimeout(() => reject(new Error('Xvfb did not report a display within 10s')), 10_000);
    displayFd.on('data', () => {
      const text = out.peek();
      if (text.includes('\n')) {
        clearTimeout(timer);
        resolve(Number(text.trim()));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb exited early (code ${code})`));
    });
  });
}

/** JPEG SOFn segment → { width, height }. */
function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1]!;
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Decode the JPEG back to one averaged RGB pixel with ffmpeg. */
async function meanColour(jpeg: Buffer): Promise<[number, number, number]> {
  const rgb = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'mjpeg', '-i', '-', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
    child.stdin.end(jpeg);
  });
  return [rgb[0]!, rgb[1]!, rgb[2]!];
}

describe.skipIf(!haveTools)('grabX11Frame against a real Xvfb (P-005)', () => {
  beforeAll(async () => {
    display = await startXvfb();
    await run('xsetroot', ['-solid', '#ff0000'], { env: { ...process.env, DISPLAY: `:${display}` } });
  }, 20_000);

  afterAll(() => {
    xvfb?.kill('SIGTERM');
  });

  it('captures one scaled JPEG of the display it was asked for', async () => {
    const jpeg = await grabX11Frame(display, { width: 480, timeoutMs: 10_000 });
    expect(jpeg).not.toBeNull();
    expect([jpeg![0], jpeg![1]]).toEqual([0xff, 0xd8]);
    // 640x480 scaled to width 480 keeps the aspect: 480x360.
    expect(jpegSize(jpeg!)).toEqual({ width: 480, height: 360 });
    const [r, g, b] = await meanColour(jpeg!);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  }, 20_000);

  it('answers null — never throws — for a display that does not exist', async () => {
    let missing = display + 500;
    while (existsSync(`/tmp/.X11-unix/X${missing}`)) missing += 1;
    expect(await grabX11Frame(missing, { width: 480, timeoutMs: 10_000 })).toBeNull();
  }, 20_000);

  it('the process thumbnailer serves the same real frame from cache on a second read', async () => {
    const t = createDesktopThumbnailer();
    const first = await t.thumbnail(display);
    const second = await t.thumbnail(display);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(t.stats()).toMatchObject({ captures: 1, cacheHits: 1 });
  }, 20_000);
});

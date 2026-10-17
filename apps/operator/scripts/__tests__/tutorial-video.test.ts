import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_TUTORIAL_CHAPTERS } from '../../../../packages/operator-core/lib/onboarding/product-tutorial-lesson';
import { captionCues, tutorialVideoMedia, validateManifest, verifyPublishedTutorial, vttTimestamp, webVtt } from '../tutorial-video-contract.mjs';

const manifest = () => ({ project: { workspaceId: 'same-cloud', projectSlug: 'workshop-planner', portalOrigin: 'https://app.papercusp.com' },
  chapters: PRODUCT_TUTORIAL_CHAPTERS.map(chapter => ({ id: chapter.id, text: 'Actual narration.', recordingPath: '/recorded/portal.webm', recordingStartSeconds: 0, recordingDurationSeconds: 5,
    provenance: { workspaceId: 'same-cloud', projectSlug: 'workshop-planner', capturedAt: '2026-10-16T17:00:00Z', evidenceRefs: ['recording:portal-webm'] } })) });

describe('real-footage tutorial production contract', () => {
  it('requires the complete curriculum and one cloud project identity', () => {
    expect(validateManifest(manifest()).chapters).toHaveLength(12);
    const missing = manifest(); missing.chapters.pop();
    expect(() => validateManifest(missing)).toThrow('all tutorial chapters');
    const changed = manifest(); changed.chapters[8].provenance.workspaceId = 'another-cloud';
    expect(() => validateManifest(changed)).toThrow('different-project');
    const noSource = manifest(); noSource.chapters[7].provenance.evidenceRefs = [];
    expect(() => validateManifest(noSource)).toThrow('provenance');
  });
  it('refuses unbounded footage and missing narration before synthesis', () => {
    const bad = manifest(); bad.chapters[0].recordingDurationSeconds = Infinity;
    expect(() => validateManifest(bad)).toThrow('bounded');
    const empty = manifest(); empty.chapters[0].text = '  ';
    expect(() => validateManifest(empty)).toThrow('narration');
  });
  it('derives captions from speech timing and shifts them onto the measured chapter timeline', () => {
    const characters = [...'Hello there. Welcome to Papercusp.'];
    const cues = captionCues({ characters, character_start_times_seconds: characters.map((_, i) => i * .1), character_end_times_seconds: characters.map((_, i) => (i + 1) * .1) }, 61.5);
    expect(cues[0].start).toBe(61.5);
    expect(cues.at(-1)?.end).toBeCloseTo(64.9);
    expect(cues.map(cue => cue.text).join(' ')).toBe('Hello there. Welcome to Papercusp.');
    expect(webVtt(cues)).toContain('00:01:01.500 -->');
    expect(webVtt([{ start: 0, end: 1, text: '<script> & text' }])).toContain('&lt;script&gt; &amp; text');
  });
  it('rejects incomplete, overlapping and nonfinite alignment rather than fabricating captions', () => {
    expect(() => captionCues({ characters: ['a'], character_start_times_seconds: [], character_end_times_seconds: [1] })).toThrow('Incomplete');
    expect(() => captionCues({ characters: ['a', 'b'], character_start_times_seconds: [0, .5], character_end_times_seconds: [1, 2] })).toThrow('timing');
    expect(() => captionCues({ characters: ['a'], character_start_times_seconds: [NaN], character_end_times_seconds: [1] })).toThrow('timing');
    expect(vttTimestamp(3599.9996)).toBe('01:00:00.000');
  });
});

describe('published tutorial object verification', () => {
  const video = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  const captions = webVtt([{ start: 0, end: 1, text: 'Real captions.' }]);
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const publication = () => ({ videoUrl: 'https://clips.papercusp.com/tutorial-v1.mp4', captionsUrl: 'https://clips.papercusp.com/tutorial-v1.vtt',
    videoBytes: video.length, videoSha256: hash(video), captionsSha256: hash(captions) });
  const served = (url: string, init?: RequestInit) => {
    if (url.endsWith('.vtt')) return new Response(captions, { headers: { 'content-type': 'text/vtt' } });
    const range = new Headers(init?.headers).get('Range');
    if (range) {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      return new Response(video.subarray(Number(start), Number(end) + 1), { status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${video.length}` } });
    }
    return new Response(init?.method === 'HEAD' ? null : video, { headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) } });
  };
  it('checks exact video/caption identities and both initial and tail seek ranges', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => served(String(input), init));
    const checked = await verifyPublishedTutorial(publication(), { fetcher });
    expect(checked.videoSha256).toBe(hash(video));
    expect(checked.captionsSha256).toBe(hash(captions));
    expect(checked.ranges).toEqual([{ start: 0, end: 1023, total: 4096 }, { start: 3072, end: 4095, total: 4096 }]);
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('Range'))).toEqual([null, null, 'bytes=0-1023', 'bytes=3072-4095', null]);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it('uses actual range totals when HEAD omits Content-Length', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      const result = served(String(input), init);
      if (init?.method === 'HEAD') result.headers.delete('content-length');
      return result;
    };
    expect((await verifyPublishedTutorial(publication(), { fetcher })).ranges[1].total).toBe(video.length);
  });
  it.each(['ignored', 'wrong-total', 'truncated', 'wrong-bytes', 'wrong-seek'])('rejects a %s range response even when the complete object is correct', async fault => {
    const fetcher: typeof fetch = async (input, init) => {
      const range = new Headers(init?.headers).get('Range');
      if (!range) return served(String(input), init);
      if (fault === 'ignored') return new Response(video);
      const result = served(String(input), init);
      if (fault === 'wrong-total') result.headers.set('content-range', 'bytes 0-1023/9999');
      if (fault === 'truncated') return new Response(video.subarray(0, 10), { status: 206, headers: result.headers });
      if (fault === 'wrong-bytes') return new Response(Buffer.alloc(1024), { status: 206, headers: result.headers });
      if (fault === 'wrong-seek' && range.startsWith('bytes=3072')) return new Response(video.subarray(0, 1024), { status: 206, headers: result.headers });
      return result;
    };
    await expect(verifyPublishedTutorial(publication(), { fetcher })).rejects.toThrow(/range/);
  });
  it.each(['stale-video', 'wrong-head-size', 'stale-captions', 'caption-error'])('rejects %s with successful responses on the other paths', async fault => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (fault === 'stale-video' && url.endsWith('.mp4') && init?.method !== 'HEAD') return new Response(Buffer.alloc(video.length));
      if (fault === 'wrong-head-size' && init?.method === 'HEAD') return new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '1' } });
      if (fault === 'stale-captions' && url.endsWith('.vtt')) return new Response(captions.replace('Real', 'Old'), { headers: { 'content-type': 'text/vtt' } });
      if (fault === 'caption-error' && url.endsWith('.vtt')) return new Response('Unavailable', { status: 404 });
      return served(url, init);
    };
    await expect(verifyPublishedTutorial(publication(), { fetcher })).rejects.toThrow(/Published/);
  });
  it('rejects invalid origin and missing immutable identity before making a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(verifyPublishedTutorial({ ...publication(), videoUrl: 'https://other.example/video.mp4' }, { fetcher })).rejects.toThrow('public R2');
    await expect(verifyPublishedTutorial({ ...publication(), captionsSha256: '' }, { fetcher })).rejects.toThrow('identity');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a correctly hashed non-caption response instead of accepting an HTML error page', async () => {
    const text = '<!doctype html>Not a caption';
    const fetcher: typeof fetch = async (input, init) => String(input).endsWith('.vtt')
      ? new Response(text, { headers: { 'content-type': 'text/vtt' } }) : served(String(input), init);
    await expect(verifyPublishedTutorial({ ...publication(), captionsSha256: hash(text) }, { fetcher })).rejects.toThrow('no cues');
  });
  const transcript = '<!doctype html><p>Real captions.</p>';
  const portalPublication = () => ({ ...publication(), portalCaptionsUrl: 'https://app.papercusp.com/tutorial/v1.vtt',
    transcriptUrl: 'https://app.papercusp.com/tutorial/v1.html', transcriptSha256: hash(transcript) });
  const portalServed: typeof fetch = async (input, init) => String(input).startsWith('https://app.papercusp.com/')
    ? new Response(String(input).endsWith('.vtt') ? captions : transcript, { headers: { 'content-type': String(input).endsWith('.vtt') ? 'text/vtt' : 'text/html' } })
    : served(String(input), init);
  const production = () => ({ schemaVersion: 1, ...publication(), transcriptSha256: hash(transcript), durationSeconds: 60,
    chapters: PRODUCT_TUTORIAL_CHAPTERS.map((chapter, index) => ({ id: chapter.id, startSeconds: index * 5, durationSeconds: 5, transcript: `Narration ${chapter.id}.` })) });
  it('checks the exact Portal caption/transcript copies and maps measured chapters to the existing guide prop', async () => {
    const checked = await verifyPublishedTutorial(portalPublication(), { fetcher: portalServed });
    const media = tutorialVideoMedia(production(), checked);
    expect(media).toMatchObject({ src: publication().videoUrl, captionsSrc: portalPublication().portalCaptionsUrl, transcriptHref: portalPublication().transcriptUrl });
    expect(media.chapters).toEqual(production().chapters.map(({ durationSeconds: _, ...chapter }) => chapter));
    expect(media.id).toMatch(/^cloud-portal-tutorial-[a-f0-9]{64}$/);
    expect(tutorialVideoMedia(production(), checked).id).toBe(media.id);
  });
  it.each(['captions', 'transcript', 'mime', 'missing'])('rejects a stale or unavailable Portal %s copy despite valid R2 objects', async fault => {
    const fetcher: typeof fetch = async (input, init) => {
      if (!String(input).startsWith('https://app.papercusp.com/')) return portalServed(input, init);
      if (fault === 'missing') return new Response(null, { status: 404 });
      if (fault === 'mime') return new Response(captions, { headers: { 'content-type': 'text/html' } });
      if (String(input).endsWith(fault === 'captions' ? '.vtt' : '.html')) return new Response('stale', { headers: { 'content-type': fault === 'captions' ? 'text/vtt' : 'text/html' } });
      return portalServed(input, init);
    };
    await expect(verifyPublishedTutorial(portalPublication(), { fetcher })).rejects.toThrow(/Portal/);
  });
  it('refuses cross-origin Portal assets before any network call', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(verifyPublishedTutorial({ ...portalPublication(), portalCaptionsUrl: 'https://other.example/v1.vtt' }, { fetcher })).rejects.toThrow('Portal origin');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['videoSha256', 'captionsSha256', 'transcriptSha256', 'videoBytes'])('refuses a %s mismatch between production and verified uploads', async key => {
    const checked = await verifyPublishedTutorial(portalPublication(), { fetcher: portalServed });
    expect(() => tutorialVideoMedia({ ...production(), [key]: key === 'videoBytes' ? 1 : 'a'.repeat(64) }, checked)).toThrow('production receipt');
  });
  it.each(['missing', 'order', 'offset', 'duration', 'transcript', 'total'])('refuses %s chapter metadata rather than guessing guide offsets', async fault => {
    const checked = await verifyPublishedTutorial(portalPublication(), { fetcher: portalServed });
    const receipt = production();
    if (fault === 'missing') receipt.chapters.pop();
    if (fault === 'order') receipt.chapters.reverse();
    if (fault === 'offset') receipt.chapters[3].startSeconds += 1;
    if (fault === 'duration') receipt.chapters[3].durationSeconds = NaN;
    if (fault === 'transcript') receipt.chapters[3].transcript = ' ';
    if (fault === 'total') receipt.durationSeconds += 2;
    expect(() => tutorialVideoMedia(receipt, checked)).toThrow(/chapter|timeline/);
  });
  it('changes saved-position identity when the delivered caption edition changes', async () => {
    const checked = await verifyPublishedTutorial(portalPublication(), { fetcher: portalServed });
    const before = tutorialVideoMedia(production(), checked);
    const captionsSha256 = 'b'.repeat(64);
    const after = tutorialVideoMedia({ ...production(), captionsSha256 }, { ...checked, captionsSha256 });
    expect(after.id).not.toBe(before.id);
  });
});

/** Validation, captions and published-object checks for the real-footage tutorial. */
import { createHash } from 'node:crypto';
import { PRODUCT_TUTORIAL_CHAPTERS } from '@papercusp/operator-core/lib/onboarding/product-tutorial-lesson';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function validateManifest(manifest) {
  const project = manifest?.project;
  if (!project?.workspaceId || !project?.projectSlug || project.portalOrigin !== 'https://app.papercusp.com') throw new Error('A real cloud portal workspace and project are required');
  const expected = PRODUCT_TUTORIAL_CHAPTERS.map(chapter => chapter.id);
  if (!Array.isArray(manifest.chapters) || manifest.chapters.map(chapter => chapter.id).join(',') !== expected.join(',')) throw new Error('Provide all tutorial chapters once, in curriculum order');
  for (const chapter of manifest.chapters) {
    if (!chapter.text?.trim() || !chapter.recordingPath || /[\r\n]/.test(chapter.recordingPath)) throw new Error(`${chapter.id}: narration and a local real recording are required`);
    if (!Number.isFinite(chapter.recordingStartSeconds) || chapter.recordingStartSeconds < 0 || !Number.isFinite(chapter.recordingDurationSeconds) || chapter.recordingDurationSeconds <= 0) throw new Error(`${chapter.id}: explicit bounded recording offsets are required`);
    const evidence = chapter.provenance;
    if (evidence?.workspaceId !== project.workspaceId || evidence?.projectSlug !== project.projectSlug || !Number.isFinite(Date.parse(evidence?.capturedAt)) || !Array.isArray(evidence?.evidenceRefs) || !evidence.evidenceRefs.length || evidence.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error(`${chapter.id}: missing or different-project recording provenance`);
  }
  return manifest;
}

/**
 * @param {{ characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[] }} alignment
 * @param {number} [offsetSeconds]
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function captionCues(alignment, offsetSeconds = 0) {
  const chars = alignment?.characters, starts = alignment?.character_start_times_seconds, ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !chars.length || chars.length !== starts?.length || chars.length !== ends?.length) throw new Error('Incomplete narration alignment');
  const cues = []; let text = '', first = 0, last = 0;
  const flush = () => { if (text.trim()) cues.push({ start: first + offsetSeconds, end: Math.max(first + .04, last) + offsetSeconds, text: text.trim() }); text = ''; };
  for (let index = 0; index < chars.length; index += 1) {
    if (typeof chars[index] !== 'string' || !Number.isFinite(starts[index]) || !Number.isFinite(ends[index]) || starts[index] < 0 || ends[index] < starts[index] || (index && starts[index] < ends[index - 1] - .001)) throw new Error('Invalid narration timing');
    if (!text) first = starts[index];
    text += chars[index]; last = ends[index];
    if ((text.length >= 70 && /\s/.test(chars[index])) || (text.length >= 25 && /[.!?]/.test(chars[index]))) flush();
  }
  flush(); return cues;
}

export function vttTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid caption offset');
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
export function webVtt(cues) {
  // Narration paragraphs must not become blank-line cue delimiters.
  return 'WEBVTT\n\n' + cues.map((cue, index) => `${index + 1}\n${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${escapeHtml(cue.text.replace(/\s+/g, ' ').trim())}\n`).join('\n');
}

/**
 * Check the exact published bytes and two seek ranges, without treating HTTP
 * success as proof that a browser can decode the video or display its captions.
 * @param {{ videoUrl: string, captionsUrl: string, videoSha256: string, captionsSha256: string, videoBytes: number, portalCaptionsUrl?: string, transcriptUrl?: string, transcriptSha256?: string }} publication
 * @param {{ fetcher?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function verifyPublishedTutorial(publication, { fetcher = fetch, signal } = {}) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const { videoUrl, captionsUrl, videoSha256, captionsSha256, videoBytes } = publication;
  for (const value of [videoUrl, captionsUrl]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'clips.papercusp.com' || url.port || url.username || url.password || url.hash) throw new Error('Use exact public R2 clips URLs');
  }
  if (videoUrl === captionsUrl || !/^[a-f0-9]{64}$/.test(videoSha256) || !/^[a-f0-9]{64}$/.test(captionsSha256) || !Number.isSafeInteger(videoBytes) || videoBytes <= 0) throw new Error('Published media identity is incomplete');
  const portalAssets = publication.portalCaptionsUrl !== undefined || publication.transcriptUrl !== undefined || publication.transcriptSha256 !== undefined;
  if (portalAssets) {
    for (const value of [publication.portalCaptionsUrl, publication.transcriptUrl]) {
      const url = new URL(value || '');
      if (url.origin !== 'https://app.papercusp.com' || url.username || url.password || url.hash) throw new Error('Portal caption and transcript copies must use the Portal origin');
    }
    if (publication.portalCaptionsUrl === publication.transcriptUrl || !/^[a-f0-9]{64}$/.test(publication.transcriptSha256 || '')) throw new Error('Portal transcript identity is incomplete');
  }
  const request = (url, method = 'GET', headers = {}) => fetcher(url, { method, headers: { 'Accept-Encoding': 'identity', ...headers }, redirect: 'error', signal });
  const head = await request(videoUrl, 'HEAD');
  if (head.status !== 200 || !/^(video|application)\/mp4(?:;|$)/i.test(head.headers.get('content-type') || '')) throw new Error('Published video HEAD is not an MP4');
  const advertisedSize = head.headers.get('content-length');
  if (advertisedSize !== null && advertisedSize !== String(videoBytes)) throw new Error('Published video HEAD size differs from production');
  const response = await request(videoUrl);
  if (response.status !== 200) throw new Error('Published video download failed');
  const video = Buffer.from(await response.arrayBuffer());
  if (video.length !== videoBytes || hash(video) !== videoSha256) throw new Error('Published video bytes differ from production');
  const ranges = [];
  // The tail request exercises a nonzero seek, rather than only the first bytes.
  for (const [start, end] of [[0, Math.min(1023, videoBytes - 1)], [Math.max(0, videoBytes - 1024), videoBytes - 1]]) {
    const range = await request(videoUrl, 'GET', { Range: `bytes=${start}-${end}` });
    if (range.status !== 206 || range.headers.get('content-range') !== `bytes ${start}-${end}/${videoBytes}`) throw new Error('Published video range response is inconsistent');
    const bytes = Buffer.from(await range.arrayBuffer());
    if (!bytes.equals(video.subarray(start, end + 1))) throw new Error('Published video range bytes differ from the object');
    ranges.push({ start, end, total: videoBytes });
  }
  const captionsResponse = await request(captionsUrl);
  if (captionsResponse.status !== 200 || !/^text\/vtt(?:;|$)/i.test(captionsResponse.headers.get('content-type') || '')) throw new Error('Published captions are unavailable');
  const captions = Buffer.from(await captionsResponse.arrayBuffer());
  const text = captions.toString('utf8').replace(/^\uFEFF/, '');
  if (hash(captions) !== captionsSha256 || !/^WEBVTT(?:[ \t]|\r?\n)/.test(text) || !text.includes(' --> ')) throw new Error('Published captions differ from production or contain no cues');
  if (portalAssets) {
    const copy = await request(publication.portalCaptionsUrl);
    if (copy.status !== 200 || !/^text\/vtt(?:;|$)/i.test(copy.headers.get('content-type') || '') || hash(Buffer.from(await copy.arrayBuffer())) !== captionsSha256) throw new Error('Portal captions differ from production or are unavailable');
    const transcript = await request(publication.transcriptUrl);
    if (transcript.status !== 200 || !/^text\/html(?:;|$)/i.test(transcript.headers.get('content-type') || '') || hash(Buffer.from(await transcript.arrayBuffer())) !== publication.transcriptSha256) throw new Error('Portal transcript differs from production or is unavailable');
  }
  return { videoUrl, captionsUrl, videoSha256, captionsSha256, videoBytes, captionsBytes: captions.length, ranges,
    ...(portalAssets ? { portalCaptionsUrl: publication.portalCaptionsUrl, transcriptUrl: publication.transcriptUrl, transcriptSha256: publication.transcriptSha256 } : {}) };
}

/** Map measured production + verified uploads to the guide's existing media prop.
 * This creates no authentication, project, or browser playback evidence.
 * @param {any} production
 * @param {Awaited<ReturnType<typeof verifyPublishedTutorial>>} published
 * @returns {import('@papercusp/operator-core/lib/onboarding/product-tutorial-lesson').ProductTutorialVideoMedia}
 */
export function tutorialVideoMedia(production, published) {
  if (production?.schemaVersion !== 1 || !published.portalCaptionsUrl || !published.transcriptUrl
    || !published.transcriptSha256 || !Number.isFinite(production.durationSeconds) || production.durationSeconds <= 0
    || ['videoSha256', 'captionsSha256', 'transcriptSha256', 'videoBytes'].some(key => production[key] !== published[key])) throw new Error('Verified publication does not match the production receipt');
  const expected = PRODUCT_TUTORIAL_CHAPTERS.map(chapter => chapter.id);
  if (!Array.isArray(production.chapters) || production.chapters.map(chapter => chapter.id).join(',') !== expected.join(',')) throw new Error('Production chapters must match the complete curriculum');
  let end = 0;
  const chapters = production.chapters.map(chapter => {
    if (!Number.isFinite(chapter.startSeconds) || Math.abs(chapter.startSeconds - end) > .001
      || !Number.isFinite(chapter.durationSeconds) || chapter.durationSeconds <= 0 || !chapter.transcript?.trim()) throw new Error('Production chapter offsets or transcript are invalid');
    end = chapter.startSeconds + chapter.durationSeconds;
    return { id: chapter.id, startSeconds: chapter.startSeconds, transcript: chapter.transcript };
  });
  if (Math.abs(end - production.durationSeconds) > .3) throw new Error('Production chapter timeline differs from the video');
  const identity = createHash('sha256').update(JSON.stringify([production.videoSha256, production.captionsSha256, production.transcriptSha256])).digest('hex');
  return { id: `cloud-portal-tutorial-${identity}`, src: published.videoUrl, captionsSrc: published.portalCaptionsUrl, transcriptHref: published.transcriptUrl, chapters };
}

/** Pure validation and captions for the real-footage tutorial production contract. */
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
  return 'WEBVTT\n\n' + cues.map((cue, index) => `${index + 1}\n${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${escapeHtml(cue.text)}\n`).join('\n');
}

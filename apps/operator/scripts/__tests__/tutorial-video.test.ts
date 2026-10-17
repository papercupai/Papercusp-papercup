import { describe, expect, it } from 'vitest';
import { PRODUCT_TUTORIAL_CHAPTERS } from '../../../../packages/operator-core/lib/onboarding/product-tutorial-lesson';
import { captionCues, validateManifest, vttTimestamp, webVtt } from '../tutorial-video-contract.mjs';

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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResultAnnotator, ServerVintage } from '@papercusp/agent-mcp';
import {
  BUILD_STAMP_MAX_OWNERS,
  BUILD_STAMP_REFRESH_MS,
  composeResultAnnotators,
  createBuildStampAnnotator,
} from './build-stamp-annotator';
import { contextGaugeAnnotator } from './context-gauge-annotator';
import {
  recordContextUsage,
  resetContextUsageCacheForTests,
} from '../system-health/context-usage-cache';
import { resetContextAnchorsForTests, seedContextAnchorForTests } from '../compaction-usage';

/** A superuser ctx resolves to ownerId === uiClientId (see coordination/identity.ts). */
const ctx = (ownerId: string) => ({ isSuperuser: true, uiClientId: ownerId }) as unknown;
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const texts = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');

function harness(initial: ServerVintage | null = { buildId: 'abc1234567', bootedAgoMs: 29 * 60_000 }) {
  let t = 1_000_000;
  let vintage: ServerVintage | null = initial;
  const annotate = createBuildStampAnnotator({ now: () => t, vintage: () => vintage });
  return {
    annotate,
    advance: (ms: number) => {
      t += ms;
    },
    setVintage: (v: ServerVintage | null) => {
      vintage = v;
    },
  };
}

describe('buildStampAnnotator (EI-23755915994199376)', () => {
  it('stamps the FIRST result for an owner with the build id, age and the staleness caveat', () => {
    const h = harness();
    const out = h.annotate(ok('body'), ctx('su-a'));
    const t = texts(out);
    expect(t).toHaveLength(2);
    expect(t[1]).toContain('served by build abc1234567');
    expect(t[1]).toContain('up 29m');
    expect(t[1]).toContain('NEWER');
    expect(t[1]).toContain('dev:pipeline_position');
    expect(out._meta?._buildStamp).toEqual({ buildId: 'abc1234567', bootedAgoMs: 29 * 60_000 });
  });

  it('stays SILENT for the same owner + same build on later calls (no per-call token cost)', () => {
    const h = harness();
    h.annotate(ok('first'), ctx('su-a'));
    for (let i = 0; i < 5; i++) {
      h.advance(60_000);
      expect(texts(h.annotate(ok('later'), ctx('su-a')))).toEqual(['later']);
    }
  });

  it('stamps each owner independently', () => {
    const h = harness();
    expect(texts(h.annotate(ok('x'), ctx('su-a')))).toHaveLength(2);
    expect(texts(h.annotate(ok('x'), ctx('su-b')))).toHaveLength(2);
    expect(texts(h.annotate(ok('x'), ctx('su-a')))).toHaveLength(1);
  });

  it('RE-stamps when the build the owner talks to changes', () => {
    const h = harness();
    h.annotate(ok('x'), ctx('su-a'));
    h.setVintage({ buildId: 'def7654321', bootedAgoMs: 5_000 });
    const out = h.annotate(ok('x'), ctx('su-a'));
    expect(texts(out)[1]).toContain('served by build def7654321');
    expect(texts(h.annotate(ok('x'), ctx('su-a')))).toHaveLength(1);
  });

  it('RE-stamps after the refresh interval so a carry-respawn that dropped the line gets it back', () => {
    const h = harness();
    h.annotate(ok('x'), ctx('su-a'));
    h.advance(BUILD_STAMP_REFRESH_MS - 1);
    expect(texts(h.annotate(ok('x'), ctx('su-a')))).toHaveLength(1);
    h.advance(1);
    expect(texts(h.annotate(ok('x'), ctx('su-a')))).toHaveLength(2);
  });

  it('says NOTHING when the host cannot name its build (never guesses)', () => {
    const none = harness(null);
    expect(texts(none.annotate(ok('x'), ctx('su-a')))).toEqual(['x']);
    const noId = harness({ buildId: null, bootedAgoMs: 1000 });
    expect(texts(noId.annotate(ok('x'), ctx('su-a')))).toEqual(['x']);
  });

  it('says NOTHING for an unattributable ctx (system / in-process call)', () => {
    const h = harness();
    expect(texts(h.annotate(ok('x'), {} as unknown))).toEqual(['x']);
  });

  it('does not double-render when the result already reports its build', () => {
    const h = harness();
    const out = h.annotate(ok('ℹ served by build abc1234567 (up 1m) — already here'), ctx('su-a'));
    expect(texts(out)).toHaveLength(1);
  });

  it('stays bounded: an evicted owner is simply stamped again, never an error', () => {
    const h = harness();
    for (let i = 0; i < BUILD_STAMP_MAX_OWNERS + 5; i++) h.annotate(ok('x'), ctx(`su-${i}`));
    // su-0 was evicted (oldest) -> stamped again; the newest is still remembered -> silent.
    expect(texts(h.annotate(ok('x'), ctx('su-0')))).toHaveLength(2);
    expect(texts(h.annotate(ok('x'), ctx(`su-${BUILD_STAMP_MAX_OWNERS + 4}`)))).toHaveLength(1);
  });
});

describe('composeResultAnnotators', () => {
  const appends =
    (text: string): ResultAnnotator =>
    (r) => ({ ...r, content: [...r.content, { type: 'text' as const, text }] });

  it('feeds each annotator the previous output, in order', () => {
    expect(texts(composeResultAnnotators(appends('A'), appends('B'))(ok('x'), {} as unknown))).toEqual(['x', 'A', 'B']);
  });

  it('skips a throwing annotator instead of failing the tool call it only decorates', () => {
    const boom: ResultAnnotator = () => {
      throw new Error('boom');
    };
    expect(texts(composeResultAnnotators(boom, appends('B'))(ok('x'), {} as unknown))).toEqual(['x', 'B']);
  });
});

/**
 * The reason this is COMPOSED rather than registered separately: tooldef keeps ONE annotator, so a
 * second setResultAnnotator() call would silently evict the context gauge. Prove both survive.
 */
describe('composed with the context gauge', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-stamp-gauge-'));
  });
  afterEach(() => {
    resetContextUsageCacheForTests();
    resetContextAnchorsForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a hot owner sees BOTH the gauge line and the build stamp, each once in its own item', () => {
    const owner = 'su-hot-stamp';
    const tokens = 270_000;
    const file = path.join(dir, 't.jsonl');
    const overhead = '{"t":""}\n'.length;
    fs.writeFileSync(file, `{"t":"${'x'.repeat(tokens * 4 - overhead)}"}\n`);
    if (!seedContextAnchorForTests(owner, file)) throw new Error('anchor seed failed');
    recordContextUsage(owner, tokens, 300_000, Date.now());

    const h = harness();
    const composed = composeResultAnnotators(contextGaugeAnnotator, h.annotate);
    const t = texts(composed(ok('body'), ctx(owner)));
    expect(t).toHaveLength(3);
    expect(t[1]).toContain('context: 270000/300000 (90%)');
    expect(t[2]).toContain('served by build abc1234567');

    // Second call: the gauge keeps speaking (it is stateless), the build stamp does not.
    const t2 = texts(composed(ok('body'), ctx(owner)));
    expect(t2).toHaveLength(2);
    expect(t2[1]).toContain('context: 270000/300000');
  });
});

import { describe, it, expect } from 'vitest';
import {
  HOLDER_SELF_MANAGEMENT_SHARE_MAX,
  summarizeHolderSelfManagement,
} from './goal-holder-behavior-metrics';

// The measured agent-origin mix of holder su-d5bfd1a5 on goal 60d3a8 (2026-10-07..08 15:30Z,
// tools:invoke unwrapped), trimmed to the tools that carry the verdict plus the work tail.
const BASELINE_MIX: Record<string, number> = {
  'loop:status': 192,
  'loop:checkpoint': 153,
  'goals:get': 122,
  'coord:orient': 99,
  'tools:find': 74,
  'work_items:get': 71,
  'fleet:assignments': 64,
  'coord:send': 64,
  'facts:list': 49,
  'coord:inbox': 48,
  'improvements:capture': 42,
  'coord:whoami': 40,
  'coord:read': 38,
  'coord:declare-intent': 30,
  'plans:get': 28,
  'code:run': 28,
  'session:request-compaction': 24,
  'events:status': 12,
  'orders:list': 10,
  'coord:plan-events': 7,
  'mode:get': 3,
  'loop:arm': 2,
  'config:set-compaction-limit': 2,
  'mode:set': 1,
};

describe('summarizeHolderSelfManagement (P-007)', () => {
  it('reproduces the measured ~60% baseline and fails the <30% target', () => {
    const s = summarizeHolderSelfManagement(BASELINE_MIX);
    expect(s.selfManagement).toBe(820);
    expect(s.total).toBe(1203);
    expect(s.share).toBeCloseTo(820 / 1203, 6);
    expect(s.share!).toBeGreaterThan(0.6);
    expect(s.withinTarget).toBe(false);
    expect(s.byClass).toEqual({ 'own-state-read': 534, continuity: 212, 'tool-discovery': 74 });
    expect(s.top.slice(0, 3)).toEqual([
      { tool: 'loop:status', n: 192 },
      { tool: 'loop:checkpoint', n: 153 },
      { tool: 'goals:get', n: 122 },
    ]);
  });

  it('passes the target once wake-delivered state removes the re-fetches', () => {
    // Positive control: the same work, one checkpoint per wake, no state re-reads.
    const s = summarizeHolderSelfManagement({
      'loop:checkpoint': 40,
      'work_items:get': 71,
      'fleet:assignments': 64,
      'coord:send': 64,
      'plans:get': 28,
      'code:run': 28,
      'coord:inbox': 48,
    });
    expect(s.share!).toBeLessThan(HOLDER_SELF_MANAGEMENT_SHARE_MAX);
    expect(s.withinTarget).toBe(true);
  });

  it('excludes ambient tools from both sides and treats peer messages as stewardship', () => {
    const s = summarizeHolderSelfManagement({
      'activity:report': 857,
      'journal:record-turn': 99,
      'coord:glance': 30,
      'coord:inbox': 10,
      'coord:read': 10,
      'goals:get': 5,
    });
    expect(s.total).toBe(25);
    expect(s.selfManagement).toBe(5);
    expect(s.share).toBeCloseTo(0.2, 6);
  });

  it('reports an empty window as unmeasured, never as zero', () => {
    const s = summarizeHolderSelfManagement({ 'activity:report': 4 });
    expect(s).toMatchObject({ total: 0, selfManagement: 0, share: null, withinTarget: null });
  });
});

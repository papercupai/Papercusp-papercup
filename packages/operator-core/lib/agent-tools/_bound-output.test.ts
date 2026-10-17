import { describe, it, expect } from 'vitest';
import { boundRowField, boundListField, trimToByteBudget } from './_bound-output';

describe('boundRowField (EI-1597 — shared high-fanout read-tool bound)', () => {
  it('returns a short field unchanged, no truncation flags', () => {
    const rows = [{ id: 'a', body: 'short' }];
    const out = boundRowField(rows, 'body', 100, 10_000);
    expect(out[0]).toEqual(rows[0]);
    expect('body_truncated' in out[0]).toBe(false);
  });

  it('excerpts a long field to the cap + stamps <field>_truncated/_full_chars', () => {
    const long = 'x'.repeat(600);
    const out = boundRowField([{ id: 'a', body: long }], 'body', 200, 10_000);
    const r = out[0] as { body: string; body_truncated?: true; body_full_chars?: number };
    expect(r.body.length).toBe(200); // n=1 → min(200, 10000) = 200
    expect(r.body_truncated).toBe(true);
    expect(r.body_full_chars).toBe(600);
  });

  it('keeps the value self-describing when a projection drops the sibling flags', () => {
    const out = boundRowField([{ id: 'a', body: 'x'.repeat(600) }], 'body', 200, 10_000);
    const bodyOnly = out[0]!.body as string;
    expect(bodyOnly).toContain('TRUNCATED');
    expect(bodyOnly).toMatch(/\+\d+ chars/);
  });

  it('keeps the TOTAL field text bounded by the budget at any row count', () => {
    const n = 500;
    const rows = Array.from({ length: n }, (_, i) => ({ id: `${i}`, body: 'y'.repeat(1000) }));
    const out = boundRowField(rows, 'body', 200, 10_000);
    const total = out.reduce((s, r) => s + (typeof r.body === 'string' ? r.body.length : 0), 0);
    expect(total).toBeLessThanOrEqual(10_000);
    expect((out[0].body as string).length).toBe(Math.floor(10_000 / n)); // 20
  });

  it('works on an arbitrary field name and preserves other fields', () => {
    const rows = [{ id: 'a', summary: 'z'.repeat(500), state: 'open' }];
    const out = boundRowField(rows, 'summary', 120, 8_000);
    const r = out[0] as { id: string; summary: string; state: string; summary_truncated?: true };
    expect(r.id).toBe('a');
    expect(r.state).toBe('open');
    expect(r.summary.length).toBe(120);
    expect(r.summary_truncated).toBe(true);
  });

  it('handles empty list + non-string field value', () => {
    expect(boundRowField([], 'body', 100, 1000)).toEqual([]);
    const out = boundRowField([{ id: 'a', body: null }], 'body', 100, 1000);
    expect(out[0]).toEqual({ id: 'a', body: null }); // non-string → treated as '' → unchanged
  });
});

describe('boundListField (EI-1597 — cap a per-row array field)', () => {
  it('caps a long array to maxItems + stamps <field>_total/_truncated', () => {
    const rows = [{ id: 'a', queued: [1, 2, 3, 4, 5] }];
    const out = boundListField(rows, 'queued', 2);
    const r = out[0] as { queued: number[]; queued_total?: number; queued_truncated?: true };
    expect(r.queued).toEqual([1, 2]);
    expect(r.queued_total).toBe(5);
    expect(r.queued_truncated).toBe(true);
  });

  it('leaves a short array (and non-array values) untouched', () => {
    expect(boundListField([{ id: 'a', queued: [1, 2] }], 'queued', 5)[0]).toEqual({ id: 'a', queued: [1, 2] });
    expect(boundListField([{ id: 'a', queued: null }], 'queued', 5)[0]).toEqual({ id: 'a', queued: null });
  });
});

describe('trimToByteBudget (EI-1597 — byte-budget backstop for many-field rows)', () => {
  it('keeps rows until the serialized budget is hit, then stops', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, blob: 'q'.repeat(500) }));
    const { kept, truncated } = trimToByteBudget(rows, 6000);
    expect(truncated).toBe(true);
    expect(kept.length).toBeLessThan(100);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(6000 + 600); // ~one row of slack
  });

  it('keeps everything when it fits + flags truncated=false', () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const { kept, truncated } = trimToByteBudget(rows, 10_000);
    expect(kept).toEqual(rows);
    expect(truncated).toBe(false);
  });

  it('always keeps at least the first row even if it alone exceeds the budget', () => {
    const { kept, truncated } = trimToByteBudget([{ id: 1, blob: 'x'.repeat(5000) }, { id: 2 }], 100);
    expect(kept.length).toBe(1);
    expect(truncated).toBe(true);
  });

  it('handles an empty list', () => {
    expect(trimToByteBudget([], 1000)).toEqual({ kept: [], truncated: false });
  });
});

/**
 * WI-6554700010009155 (owner directive #1746): a blocked work-item must NAME its blocker.
 *
 * work_items:set_state already refuses `blocked` without an active typed blocker, but
 * work_items:create accepted `state: 'blocked'` with no blocker at all — measured 2026-10-12:
 * 14 rows were born blocked with nothing naming what they wait on (e.g. WI-6554700010008642,
 * created via `workItems.create({ state: 'blocked' })`). These tests pin the create door shut,
 * for the single-item and the items[] shapes, and keep the ordinary entry states working.
 */
import { describe, expect, it } from 'vitest';
import create from './create';

type ParseResult = { success: boolean; error?: { issues?: Array<{ message: string }> } };
const parse = (value: unknown): ParseResult =>
  (create.args as unknown as { safeParse: (v: unknown) => ParseResult }).safeParse(value);

const messages = (r: ParseResult): string =>
  (r.error?.issues ?? []).map((i) => i.message).join('\n');

describe('work_items:create refuses state:blocked (WI-6554700010009155)', () => {
  it('refuses a single-item create straight into blocked and names the blocker verbs', () => {
    const r = parse({ kind: 'task', title: 'waits on something', state: 'blocked' });
    expect(r.success).toBe(false);
    expect(messages(r)).toMatch(/must name its blocker/);
    expect(messages(r)).toMatch(/work_items:set_blocker/);
  });

  it('refuses case and whitespace variants of blocked', () => {
    for (const state of ['BLOCKED', ' Blocked ']) {
      expect(parse({ kind: 'task', title: 'variant', state }).success).toBe(false);
    }
  });

  it('refuses blocked inside an items[] batch row', () => {
    const r = parse({ items: [{ kind: 'task', title: 'batched', state: 'blocked' }] });
    expect(r.success).toBe(false);
    expect(messages(r)).toMatch(/must name its blocker/);
  });

  it('still accepts the ordinary non-terminal entry states', () => {
    expect(parse({ kind: 'task', title: 'starting now', state: 'wip' }).success).toBe(true);
    expect(parse({ kind: 'task', title: 'default entry' }).success).toBe(true);
  });
});

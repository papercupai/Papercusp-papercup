/**
 * inbox-q-arg-redirect.test.ts — EI-21901625037175266.
 *
 * `coord:inbox` deliberately has no free-text `q` search (it is a bounded VIEW,
 * D-002/D-013 R1 — same ratified reason `since` is absent). Before this fix, an
 * agent passing `q` got a bare Zod "unrecognized key" rejection with no pointer
 * to `coord:feed { q }`, the tool that DOES support it — the exact failure shape
 * `since` had before its own `argRedirects` entry was added (filed 10+ times per
 * EI-21349112990078630's comment in inbox.ts). Pins the `q` redirect alongside
 * the pre-existing `since` one so a future edit can't drop it silently.
 */
import { describe, it, expect } from 'vitest';
import inboxTool from './inbox';

describe('coord:inbox guidance.argRedirects', () => {
  it('redirects a rejected `q` key to coord:feed { q } with an explanatory note', () => {
    const redirect = inboxTool.guidance?.argRedirects?.q;
    expect(redirect).toEqual({
      tool: 'coord:feed',
      args: { q: '<substring>' },
      note: expect.stringContaining('coord:feed'),
    });
  });

  it('keeps the pre-existing `since` redirect to coord:feed intact', () => {
    const redirect = inboxTool.guidance?.argRedirects?.since;
    expect(redirect).toEqual({
      tool: 'coord:feed',
      args: { since: '<ISO-timestamp>', owner: '<your ownerId>' },
      note: expect.stringContaining('coord:feed'),
    });
  });

  it('redirects rejected `include_retracted` to coord:feed for forensic history', () => {
    expect(Object.keys(inboxTool.args.out.shape)).not.toContain('include_retracted');
    const redirect = inboxTool.guidance?.argRedirects?.include_retracted;
    expect(redirect).toEqual({
      tool: 'coord:feed',
      args: { include_retracted: true },
      note: expect.stringContaining('coord:feed'),
    });
  });
});

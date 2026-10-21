/**
 * Prototype coord-wake channel emitter (plan client-native-features-adoption-2026-10-21 P-005, R-5).
 *
 * The schema below is a transcription of the one the installed CLI validates channel
 * notifications with (claude 2.1.293: `u({method:R("notifications/claude/channel"),
 * params:u({content:o(),meta:pe(o(),o()).optional()})})`), plus its meta-key filter
 * `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. A notification that fails it is ignored by the CLI; a meta key
 * that fails the filter is dropped with a warning.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CHANNEL_META_KEY_PATTERN,
  CLAUDE_CHANNEL_CAPABILITY,
  CLAUDE_CHANNEL_NOTIFICATION_METHOD,
  buildChannelNotification,
  channelServerCapabilities,
  coordWakeChannelNotification,
  sanitizeChannelMeta,
} from './coord-channel-emitter';

const CliChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
  }),
});

/** Keys the CLI would keep (mirrors its filter, written out independently of the module). */
const cliKeptKeys = (meta: Record<string, string> | undefined) =>
  Object.keys(meta ?? {}).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));

describe('channel server handshake', () => {
  it('declares the experimental claude/channel capability the CLI checks for', () => {
    expect(CLAUDE_CHANNEL_CAPABILITY).toBe('claude/channel');
    expect(channelServerCapabilities()).toEqual({ experimental: { 'claude/channel': {} } });
  });
});

describe('coordWakeChannelNotification', () => {
  const wake = {
    msgId: 'coord-send-abc123',
    from: 'su-1dfc1766',
    summary: 'Released psu-launcher.mjs',
    body: 'Go ahead with the JSDoc fix.',
    expects: 'action' as const,
    workItem: 'EI-26611852291346695',
    sentAt: '2026-10-21T19:30:24.658Z',
  };

  it('produces a message the CLI schema accepts, with the coord routing fields in meta', () => {
    const n = coordWakeChannelNotification(wake);
    expect(n.jsonrpc).toBe('2.0');
    expect(n.method).toBe(CLAUDE_CHANNEL_NOTIFICATION_METHOD);
    expect(CliChannelNotification.safeParse(n).success).toBe(true);
    expect(n.params.content).toBe('Released psu-launcher.mjs\n\nGo ahead with the JSDoc fix.');
    expect(n.params.meta).toEqual({
      msg_id: 'coord-send-abc123',
      from: 'su-1dfc1766',
      expects: 'action',
      work_item: 'EI-26611852291346695',
      sent_at: '2026-10-21T19:30:24.658Z',
    });
  });

  it('every meta key survives the CLI filter, so no routing field is silently dropped', () => {
    const meta = coordWakeChannelNotification(wake).params.meta;
    expect(cliKeptKeys(meta)).toEqual(Object.keys(meta ?? {}));
  });

  it('omits absent optional fields instead of sending empty strings', () => {
    const n = coordWakeChannelNotification({ msgId: 'm1', from: 'su-x', summary: 'ping' });
    expect(n.params).toEqual({ content: 'ping', meta: { msg_id: 'm1', from: 'su-x' } });
    expect(CliChannelNotification.safeParse(n).success).toBe(true);
  });

  it('clips long content to the cap and points at coord:read for the rest', () => {
    const n = coordWakeChannelNotification({ ...wake, body: 'x'.repeat(10_000) }, { maxContentChars: 500 });
    expect(n.params.content.length).toBe(500);
    expect(n.params.content).toMatch(/…\[clipped; full text: coord:read \{ msg_id: "coord-send-abc123" \}\]$/);
    expect(CliChannelNotification.safeParse(n).success).toBe(true);
  });

  it('leaves content under the cap untouched', () => {
    const n = coordWakeChannelNotification(wake, { maxContentChars: 500 });
    expect(n.params.content).not.toContain('clipped');
  });
});

describe('sanitizeChannelMeta', () => {
  it('rewrites keys the CLI would drop instead of losing them', () => {
    const { meta, renamed } = sanitizeChannelMeta({ 'work-item': 'WI-1', '9lives': 'cat', 'a.b': 'c', ok_key: 'v' });
    expect(meta).toEqual({ work_item: 'WI-1', _9lives: 'cat', a_b: 'c', ok_key: 'v' });
    expect(renamed).toEqual([
      { from: 'work-item', to: 'work_item' },
      { from: '9lives', to: '_9lives' },
      { from: 'a.b', to: 'a_b' },
    ]);
    for (const key of Object.keys(meta)) expect(CHANNEL_META_KEY_PATTERN.test(key)).toBe(true);
  });

  it('stringifies non-string values and omits null/undefined', () => {
    expect(sanitizeChannelMeta({ n: 3, b: true, o: { x: 1 }, gone: null, also: undefined }).meta).toEqual({
      n: '3',
      b: 'true',
      o: '{"x":1}',
    });
  });

  it('keeps the first of two keys that normalize to the same name and reports the collision', () => {
    const { meta, collisions } = sanitizeChannelMeta({ 'a-b': 'first', a_b: 'second' });
    expect(meta).toEqual({ a_b: 'first' });
    expect(collisions).toEqual(['a_b']);
  });

  it('a notification with no meta omits the field (the CLI treats meta as optional)', () => {
    const n = buildChannelNotification('hello');
    expect(n.params).toEqual({ content: 'hello' });
    expect(CliChannelNotification.safeParse(n).success).toBe(true);
  });
});

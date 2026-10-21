/**
 * Prototype coord-wake channel emitter — plan client-native-features-adoption-2026-10-21
 * P-005 (R-5, the Channels spike). NOT wired into wake delivery: it exists so the spike can
 * measure Claude Code Channels against the current psu-host socket wake, and so the adopt /
 * do-not-adopt Decision cites a real message shape instead of a guess.
 *
 * The shape below is read from the installed CLI (claude 2.1.293, 2026-10-21), not from docs:
 *
 *   - A channel is an MCP server that declares `capabilities.experimental["claude/channel"]`.
 *   - It pushes `{ method: "notifications/claude/channel", params: { content: string,
 *     meta?: Record<string, string> } }` (the CLI validates exactly this with a zod object).
 *   - The CLI drops (with a warning) every meta key that does not match
 *     /^[a-zA-Z_][a-zA-Z0-9_]*$/, then enqueues
 *     `<channel source="<server>" key="value" …>content</channel>` as a meta prompt with
 *     priority "next" (it runs as the next turn; it does not interrupt the current one).
 *   - Registration is skipped unless ALL hold: the server declared the capability; the
 *     connection did not negotiate the "modern" protocol era (no unsolicited-notification
 *     path); the provider is first-party; the `tengu_harbor` / `allow_channels` gates are on;
 *     org policy allows channels (team/enterprise need `channelsEnabled: true`); and the
 *     session named the server in `--channels` (a bare `server:` entry additionally needs
 *     `--dangerously-load-development-channels`; a plugin entry needs the approved-channels
 *     allowlist).
 *
 * Everything here is pure: no MCP transport, no I/O.
 */

/** JSON-RPC method the CLI listens for. */
export const CLAUDE_CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel' as const;

/** Experimental capability key a channel server must declare. */
export const CLAUDE_CHANNEL_CAPABILITY = 'claude/channel' as const;

/** Meta keys the CLI keeps; every other key is dropped before the prompt is built. */
export const CHANNEL_META_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Default cap on `content`; the full message stays readable through coord:read. */
export const DEFAULT_CHANNEL_CONTENT_MAX_CHARS = 4000;

export interface ClaudeChannelNotification {
  jsonrpc: '2.0';
  method: typeof CLAUDE_CHANNEL_NOTIFICATION_METHOD;
  params: { content: string; meta?: Record<string, string> };
}

/** The `capabilities` fragment a channel server returns from `initialize`. */
export function channelServerCapabilities(): { experimental: Record<string, Record<string, never>> } {
  return { experimental: { [CLAUDE_CHANNEL_CAPABILITY]: {} } };
}

/**
 * Normalize meta so the CLI keeps every entry: an invalid key is rewritten (invalid
 * characters → `_`, a leading digit gets a `_` prefix) instead of being silently dropped by
 * the CLI. Null/undefined values are omitted; other values are stringified. When two keys
 * normalize to the same name, the first one wins and the later one is reported as a collision.
 */
export function sanitizeChannelMeta(meta: Record<string, unknown> | null | undefined): {
  meta: Record<string, string>;
  renamed: Array<{ from: string; to: string }>;
  collisions: string[];
} {
  const out: Record<string, string> = {};
  const renamed: Array<{ from: string; to: string }> = [];
  const collisions: string[] = [];
  for (const [rawKey, value] of Object.entries(meta ?? {})) {
    if (value === null || value === undefined) continue;
    let key = rawKey.replace(/[^a-zA-Z0-9_]/g, '_');
    if (!/^[a-zA-Z_]/.test(key)) key = `_${key}`;
    if (key !== rawKey) renamed.push({ from: rawKey, to: key });
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      collisions.push(rawKey);
      continue;
    }
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return { meta: out, renamed, collisions };
}

/** Build one channel notification from raw content + meta. */
export function buildChannelNotification(
  content: string,
  meta?: Record<string, unknown> | null,
): ClaudeChannelNotification {
  const { meta: clean } = sanitizeChannelMeta(meta);
  return {
    jsonrpc: '2.0',
    method: CLAUDE_CHANNEL_NOTIFICATION_METHOD,
    params: Object.keys(clean).length > 0 ? { content, meta: clean } : { content },
  };
}

/** The subset of a coord wake the channel carries. */
export interface CoordWakeForChannel {
  msgId: string;
  from: string;
  summary: string;
  expects?: 'ack' | 'answer' | 'action' | 'none';
  body?: string | null;
  workItem?: string | null;
  sentAt?: string | null;
}

/**
 * Map a coord wake to a channel notification. `content` is the summary plus the body,
 * clipped to `maxContentChars` with a pointer to `coord:read` for the full text; the
 * routing fields ride in `meta` so the model sees them as tag attributes.
 */
export function coordWakeChannelNotification(
  wake: CoordWakeForChannel,
  { maxContentChars = DEFAULT_CHANNEL_CONTENT_MAX_CHARS }: { maxContentChars?: number } = {},
): ClaudeChannelNotification {
  const full = wake.body ? `${wake.summary}\n\n${wake.body}` : wake.summary;
  const pointer = `\n…[clipped; full text: coord:read { msg_id: "${wake.msgId}" }]`;
  const content =
    full.length <= maxContentChars
      ? full
      : `${full.slice(0, Math.max(0, maxContentChars - pointer.length))}${pointer}`;
  return buildChannelNotification(content, {
    msg_id: wake.msgId,
    from: wake.from,
    expects: wake.expects,
    work_item: wake.workItem,
    sent_at: wake.sentAt,
  });
}

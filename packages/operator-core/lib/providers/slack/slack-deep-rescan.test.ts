/**
 * The Slack provider's whole-history re-walk (WI-6554700010012486). The week-long rescan of an
 * already-backfilled channel (WI-6554700010012278) cannot see a message older than its window, or a
 * reply in a thread whose root is older, deleted while the daemon was offline. Every known channel's
 * whole history is therefore re-read about once per SLACK_DEEP_RESCAN_PERIOD_SECONDS, one channel at
 * a time, reporting coverage down to the channel's start so the host tombstones what Slack no longer
 * returns.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE_DIR = resolve(REPO_ROOT, 'libs/papercusp/plugins/slack');
const provider: any = await import(pathToFileURL(resolve(PACKAGE_DIR, 'provider.mjs')).href);

type FakeResponse = { status: number; headers: Record<string, string>; body: string; bodyEncoding: 'utf8' };
const json = (body: unknown): FakeResponse => ({
  status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), bodyEncoding: 'utf8',
});

/** A fake Slack workspace: member channels, history per channel, replies per `channel:threadTs`. */
function fakeWorkspace(routes: { channels?: string[]; history?: Record<string, unknown>; replies?: Record<string, unknown> }) {
  const seen: string[] = [];
  const fetchSlack = async (request: { url: string }) => {
    const url = new URL(request.url);
    seen.push(`${url.pathname.replace('/api/', '')}?${url.searchParams}`);
    const channel = url.searchParams.get('channel') ?? '';
    if (url.pathname === '/api/conversations.list') {
      return json({ ok: true, channels: (routes.channels ?? []).map((id) => ({ id, name: id.toLowerCase(), is_member: true })) });
    }
    if (url.pathname === '/api/conversations.members') return json({ ok: true, members: ['U1'] });
    const route = url.pathname === '/api/conversations.history'
      ? routes.history?.[channel]
      : url.pathname === '/api/conversations.replies' ? routes.replies?.[`${channel}:${url.searchParams.get('ts')}`] : undefined;
    return json(route === undefined ? { ok: false, error: `unexpected:${url.pathname}` } : { ok: true, ...(route as object) });
  };
  return { seen, fetchSlack };
}

const ORG = { source: 'src-org', mode: 'incremental', scope: 'organization' } as const;
const cursorState = (page: { nextCursor: string | null }) => JSON.parse(page.nextCursor ?? 'null');
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const PERIOD_MS = provider.SLACK_DEEP_RESCAN_PERIOD_SECONDS * 1_000;
const weekAgoTs = `${(NOW - provider.SLACK_RESCAN_WINDOW_SECONDS * 1_000) / 1_000}.000000`;

describe('Slack whole-history re-walk (WI-6554700010012486)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('re-walks each channel about once a period, so its spacing is at most a few weeks', () => {
    expect(provider.SLACK_DEEP_RESCAN_PERIOD_SECONDS).toBeGreaterThan(provider.SLACK_RESCAN_WINDOW_SECONDS);
    expect(provider.SLACK_DEEP_RESCAN_PERIOD_SECONDS).toBeLessThanOrEqual(90 * 24 * 60 * 60);
  });

  it('starts the re-walk clock on the first membership page and only rescans the last week', async () => {
    const slack = fakeWorkspace({ channels: ['C1', 'C5'] });
    const page = await provider.syncPage({ ...ORG, cursor: JSON.stringify({ queue: [], seen: ['C1', 'C5'] }) }, slack.fetchSlack);
    const state = cursorState(page);
    expect(state).toMatchObject({ queue: [], rescan: 'C1', rotate: 'C1', oldest: weekAgoTs, deepAt: String(NOW) });
    expect(state.deep).toBeUndefined();
  });

  it('re-reads the next channel of its own rotation from the start once period / channels has passed', async () => {
    const slack = fakeWorkspace({ channels: ['C1', 'C5'] });
    const due = { queue: [], seen: ['C1', 'C5'], rotate: 'C5', deep: 'C1', deepAt: String(NOW - PERIOD_MS / 2) };
    const state = cursorState(await provider.syncPage({ ...ORG, cursor: JSON.stringify(due) }, slack.fetchSlack));
    // The re-walk has no lower bound, keeps the week-long rotation where it was, and keeps the clock.
    expect(state).toMatchObject({ rescan: 'C5', deep: 'C5', rotate: 'C5', deepAt: due.deepAt });
    expect(state.oldest).toBeUndefined();

    const notYet = { ...due, deepAt: String(NOW - PERIOD_MS / 2 + 1_000) };
    const window = cursorState(await provider.syncPage({ ...ORG, cursor: JSON.stringify(notYet) }, slack.fetchSlack));
    expect(window).toMatchObject({ rescan: 'C1', rotate: 'C1', deep: 'C1', oldest: weekAgoTs, deepAt: notYet.deepAt });
  });

  it('reads the whole channel, re-reads an old thread, covers down to the channel start, and restarts the clock', async () => {
    const root = '1600000000.000100';
    const reply = '1600000050.000300';
    const post = '1600000100.000200';
    const slack = fakeWorkspace({
      history: { C1: { messages: [{ ts: post, text: 'old post', user: 'U1' }, { ts: root, thread_ts: root, text: 'old root', user: 'U1' }] } },
      replies: { [`C1:${root}`]: { messages: [{ ts: root, thread_ts: root, text: 'old root' }, { ts: reply, thread_ts: root, text: 'old reply', user: 'U1' }] } },
    });
    const cursor = { queue: [], seen: ['C1'], rescan: 'C1', deep: 'C1', deepAt: String(NOW - PERIOD_MS) };
    const page = await provider.syncPage({ ...ORG, cursor: JSON.stringify(cursor) }, slack.fetchSlack);

    expect(slack.seen.find((call) => call.startsWith('conversations.history'))).not.toMatch(/oldest=/);
    const channelWindow = page.coverage.find((window: { threadRef?: string }) => !window.threadRef);
    expect(channelWindow).toMatchObject({ datatype: 'chat-message', containerRef: 'C1', nativeIds: [`C1:${post}`, `C1:${root}`] });
    // No lower bound: a stored message older than any Slack still returns is tombstoned too.
    expect(channelWindow.from).toBeUndefined();
    // conversations.replies returns the root first, so the thread's window names it beside the reply.
    expect(page.coverage).toContainEqual(expect.objectContaining({ containerRef: 'C1', threadRef: root, nativeIds: [`C1:${root}`, `C1:${reply}`] }));

    expect(page.hasMore).toBe(false);
    const state = cursorState(page);
    expect(state).toMatchObject({ deep: 'C1', deepAt: String(NOW) });
    expect(state.rescan).toBeUndefined();
  });

  it('leaves the re-walk clock alone when a week-long rescan ends', async () => {
    const slack = fakeWorkspace({ history: { C1: { messages: [] } } });
    const cursor = { queue: [], seen: ['C1'], rescan: 'C1', oldest: weekAgoTs, deep: 'C1', deepAt: '1700000000000' };
    const page = await provider.syncPage({ ...ORG, cursor: JSON.stringify(cursor) }, slack.fetchSlack);
    expect(slack.seen.find((call) => call.startsWith('conversations.history'))).toMatch(/oldest=/);
    expect(cursorState(page)).toMatchObject({ deep: 'C1', deepAt: '1700000000000' });
  });
});

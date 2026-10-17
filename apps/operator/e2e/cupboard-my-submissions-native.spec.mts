import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeNativeBridgeJson } from './_native-bridge-json';

// Native WebKit journey with controlled remote inventory/mutation responses.
// The shared client/tool/Worker suites cover the real authenticated boundaries.
test('native My submissions shows review states and delists through the existing tool', async ({}, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires scripts/verify-tauri-headless.sh');
  test.setTimeout(120_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  const run = promisify(execFile);
  async function evaluate(code: string): Promise<any> {
    const { stdout } = await run(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!,
      ['eval', '--pid', process.env.VERIFY_TAURI_PID!, code], { timeout: 20_000 });
    return decodeNativeBridgeJson(stdout);
  }
  await evaluate(`(async () => {
    const original = window.fetch.bind(window);
    window.__submissionsFixture = { requests: [], delisted: false, reads: 0 };
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, location.href);
      const fixture = window.__submissionsFixture;
      if (url.pathname.endsWith('/rest-query') && url.searchParams.get('name') === 'cupboard.myListings') {
        fixture.reads++;
        const row = (id, state) => ({ id, listing_kind: 'plugin', title: id, description: '',
          listing_ref: id, review_status: state, review_reason: state === 'rejected' ? 'Missing license' : null,
          unlisted_at: id === 'Withdraw me' && fixture.delisted ? 1 : null });
        return Response.json({ rows: [{ ok: true, listings: [row('Withdraw me', 'pending'), row('Public item', 'approved'), row('Rejected item', 'rejected')],
          drafts: [{ id: 'draft', listing_kind: 'plugin', title: 'Draft item', state: 'draft', review: null, published_listing_id: null }], nextCursor: null }], version: String(Date.now()) });
      }
      if (url.pathname === '/api/agent-mcp/run-tool') {
        const payload = JSON.parse(init.body);
        fixture.requests.push(payload);
        if (payload.name !== 'cupboard:unpublish' || payload.args.listingId !== 'Withdraw me') throw new Error('Unexpected native mutation');
        fixture.delisted = true;
        return Response.json({ ok: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
      }
      return original(input, init);
    };
    await window.__TSR_ROUTER__.navigate({ to: '/cupboard', search: { kind: 'my-submissions' } });
    return true;
  })()`);
  const snapshot = () => evaluate(`(() => {
    const root = document.querySelector('[aria-label="My submissions"]');
    return { text: root?.textContent ?? '', count: root?.querySelectorAll('[data-testid="submission-card"]').length ?? 0,
      search: location.search, requests: window.__submissionsFixture.requests, reads: window.__submissionsFixture.reads };
  })()`);
  await expect.poll(async () => (await snapshot()).count, { timeout: 30_000 }).toBe(4);
  const before = await snapshot();
  for (const label of ['Draft', 'Pending review', 'Approved', 'Rejected', 'Missing license']) expect(before.text).toContain(label);
  expect(before.search).toContain('kind=my-submissions');
  await evaluate(`(() => { document.querySelector('button[aria-label="Delist Withdraw me"]').click(); return true; })()`);
  await expect.poll(async () => (await snapshot()).text, { timeout: 30_000 }).toContain('Delisted');
  const after = await snapshot();
  expect(after.requests).toEqual([{ name: 'cupboard:unpublish', args: { listingId: 'Withdraw me' } }]);
  expect(after.reads).toBeGreaterThan(before.reads);
  await info.attach('native-my-submissions', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
});

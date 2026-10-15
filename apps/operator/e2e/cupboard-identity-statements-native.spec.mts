import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeNativeBridgeJson } from './_native-bridge-json';

// Reuse the maintained frozen-SPA/compiled-Tauri rig and its real sync transport.
// This acceptance covers the isolated, unauthenticated state. Paid receipt data
// remains covered separately by the canonical transport, Worker and UI suites.
// VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='Identity usage statement' selects the
// emitted section label. The tab's full DOM id is concatenated at runtime and
// cannot serve as a literal frozen-bundle marker.
test('native Statements preserve unavailable amounts across refresh', async ({}, info) => {
  test.skip(!process.env.VERIFY_TAURI_PID, 'Requires scripts/verify-tauri-headless.sh');
  test.setTimeout(120_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_ISOLATED_SEED).toBe('ready');
  const bridge = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN!;
  expect(bridge).toBeTruthy();
  const run = promisify(execFile);
  async function evaluate(code: string) {
    const { stdout } = await run(bridge, ['eval', '--pid', process.env.VERIFY_TAURI_PID!, code], { timeout: 20_000 });
    return decodeNativeBridgeJson(stdout);
  }
  await evaluate(`(async () => {
    if (!window.__TSR_ROUTER__) throw new Error('Native router unavailable');
    await window.__TSR_ROUTER__.navigate({ to: '/cupboard' });
    return { navigated: true };
  })()`);
  await expect.poll(() => evaluate(`!!document.querySelector('[data-testid="cupboard-kind-tab-statements"]')`), { timeout: 30_000 }).toBe(true);
  await evaluate(`(() => {
    document.querySelector('[data-testid="cupboard-kind-tab-statements"]').click();
    return { clicked: true };
  })()`);
  const snapshot = () => evaluate(`(() => {
    const root = document.querySelector('[aria-label="Identity usage statement"]');
    const buttons = Array.from(root?.querySelectorAll('button') ?? []);
    return { text: root?.textContent ?? '', search: location.search,
      refreshEnabled: buttons.some(b => b.textContent === 'Refresh' && !b.disabled),
      nextDisabled: buttons.some(b => b.textContent === 'Next page' && b.disabled),
      measuredTotal: (root?.textContent ?? '').includes('Markup on this page:') };
  })()`);
  await expect.poll(async () => (await snapshot()).text, { timeout: 30_000 }).toContain('Identity usage is unavailable. No totals were measured.');
  const before = await snapshot();
  expect(before.text).toContain('Cost per accepted outcome: unavailable');
  expect(before.text).toContain('Split amounts are quotes, not payouts.');
  expect(before.search).toContain('kind=statements');
  expect(before.refreshEnabled).toBe(true);
  expect(before.nextDisabled).toBe(true);
  expect(before.measuredTotal).toBe(false);
  await evaluate(`(() => {
    const root = document.querySelector('[aria-label="Identity usage statement"]');
    Array.from(root.querySelectorAll('button')).find(b => b.textContent === 'Refresh').click();
    return { refreshed: true };
  })()`);
  await expect.poll(async () => {
    const state = await snapshot();
    return state.refreshEnabled && state.text.includes('Identity usage is unavailable. No totals were measured.');
  }, { timeout: 30_000 }).toBe(true);
  const after = await snapshot();
  expect(after.measuredTotal).toBe(false);
  expect(after.text).toContain('Cost per accepted outcome: unavailable');
  await info.attach('native-statements-unavailable', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
});

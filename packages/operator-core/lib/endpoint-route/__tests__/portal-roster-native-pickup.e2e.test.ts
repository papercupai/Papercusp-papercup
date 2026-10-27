import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { buildPortalRosterBrowser, retainPortalBrowserFailure } from '../../../test/portal-roster-browser-fixture';

// The maintained e2e configuration permits this explicitly selected live
// operator read. Two invocations let the native agent finish its sending
// turn before its next turn verifies pickup. Neither invocation waits or polls.
const phase = process.env.PAPERCUSP_ROSTER_NATIVE_PICKUP_PHASE;
const controller = process.env.PAPERCUSP_SID;
// Select only this session or a disposable canary launched by its controller.
const owner = process.env.PAPERCUSP_ROSTER_NATIVE_PICKUP_TARGET ?? controller;
const workspace = process.env.PAPERCUSP_WORKSPACE;
const witnessPath = process.env.PAPERCUSP_ROSTER_NATIVE_PICKUP_WITNESS;
// The caller resolves this using the actual selected native host. Vitest's
// PAPERCUSP_PSU_PTY_DIR intentionally points at an isolated test directory.
const nativeHostEvents = process.env.PAPERCUSP_ROSTER_NATIVE_HOST_EVENTS;
const base = 'http://127.0.0.1:3170';

type Witness = {
  owner: string; controller?: string; workspace: string; sentAt: string; msgId: string;
  receipt: any; note: string; hostEventsPath: string;
  servingBuild: string; browserBundleSha256: string;
};

function witnessLocation() {
  expect(owner).toMatch(/^su-/);
  expect(controller).toMatch(/^su-/);
  expect(workspace).toBeTruthy();
  expect(witnessPath).toBeTruthy();
  expect(nativeHostEvents).toBeTruthy();
  expect(nativeHostEvents!.endsWith('/' + owner + '.events.jsonl')).toBe(true);
  const path = resolve(witnessPath!);
  expect(path.startsWith(resolve(process.env.HOME!, '.papercusp/scratch') + '/')).toBe(true);
  return path;
}

function correlate(witness: Witness, delivery: any, native: any) {
  expect(delivery.subscriber_id).toBe(witness.owner);
  expect(delivery.workspace_id).toBe(DEFAULT_COORD_WORKSPACE);
  expect(delivery.payload.msg_id).toBe(witness.msgId);
  expect(String(native.deliveryId)).toBe(String(delivery.id));
  expect(native.kind).toBe('native-turn-start-confirmed');
  expect(Date.parse(native.ts)).toBeGreaterThanOrEqual(Date.parse(witness.sentAt));
}

it.runIf(phase === 'send')('real Portal wake records queueing for this native session without claiming pickup', async () => {
  const path = witnessLocation();
  expect(existsSync(path), 'never repeat a send with an existing witness').toBe(false);
  const health = await (await fetch(base + '/api/health')).json();
  const built = await buildPortalRosterBrowser({
    portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
    selected: owner!, neighbor: 'su-unselected-parity-native-control',
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // Supply only the host document and roster population; product callbacks
    // and their same-origin API requests execute unchanged against staging.
    await page.route(base + '/__parity_native_pickup__**', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><div id="root"></div><script src="/__parity_native_bundle__.js"></script>',
    }));
    await page.route(base + '/__parity_native_bundle__.js', route => route.fulfill({
      contentType: 'text/javascript', body: Buffer.from(built.bundle),
    }));
    // The actual roster control is the readiness condition; unrelated asset
    // load events are not part of the message/wake acceptance contract.
    await page.goto(base + '/__parity_native_pickup__?ws=' + encodeURIComponent(workspace!), { waitUntil: 'commit' });
    try { await page.getByTestId('agent-select-' + owner).check({ timeout: 5_000 }); }
    catch (error) {
      await retainPortalBrowserFailure(page, dirname(path), error, errors);
      throw error;
    }
    expect(await page.getByTestId('agent-select-su-unselected-parity-native-control').isChecked()).toBe(false);
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/admin/coord/send'
      && value.request().method() === 'POST');
    const sentAt = new Date().toISOString();
    await page.getByTestId('agents-bulk-wake').click();
    const observed = await response;
    const receipt = await observed.json();
    // Preserve the write outcome before assertions so a refusal or a UI error
    // cannot turn the next invocation into an accidental duplicate send.
    writeFileSync(path, JSON.stringify({ owner, controller, workspace, sentAt, receipt }, null, 2), { flag: 'wx', mode: 0o600 });
    expect(observed.status()).toBe(200);
    expect(receipt.ok).toBe(true);
    expect(receipt.results).toHaveLength(1);
    const result = receipt.results[0];
    expect(result.to).toEqual([owner]);
    expect(result.msg_id).toEqual(expect.any(String));
    expect(result.wake.pickupConfirmed).toBe(false);
    expect(result.wake.queued).toBeGreaterThan(0);
    const note = page.getByTestId('agents-bulk-note');
    await expect.poll(() => note.innerText()).toMatch(/queued; pickup not confirmed/);
    expect(errors).toEqual([]);
    const witness: Witness = { owner: owner!, controller, workspace: workspace!, sentAt, msgId: result.msg_id,
      receipt, note: await note.innerText(), hostEventsPath: nativeHostEvents!,
      servingBuild: health.sha ?? health.buildSha ?? health.version,
      browserBundleSha256: createHash('sha256').update(built.bundle).digest('hex') };
    writeFileSync(path, JSON.stringify(witness, null, 2), { mode: 0o600 });
    console.info('PORTAL_NATIVE_WAKE_QUEUED ' + JSON.stringify({ owner, msgId: witness.msgId, witnessPath: path }));
  } finally { await browser.close(); }
}, 60_000);

it.runIf(phase === 'verify')('later native turn correlates the exact Portal wake message and rejects other receipts', async () => {
  const path = witnessLocation();
  const witness: Witness = JSON.parse(readFileSync(path, 'utf8'));
  expect(witness.owner).toBe(owner);
  expect(witness.controller ?? witness.owner).toBe(controller);
  expect(witness.workspace).toBe(workspace);
  const { sql } = getOrgPg();
  const deliveries = await sql`
    SELECT id, workspace_id, subscriber_id, payload
    FROM harness_shared.event_wake_deliveries
    WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND subscriber_id = ${owner!}
      AND payload->>'msg_id' = ${witness.msgId}
    ORDER BY id DESC LIMIT 10`;
  expect(deliveries.length).toBeGreaterThan(0);
  const events = readFileSync(nativeHostEvents!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const native = events.find(row => row.kind === 'native-turn-start-confirmed'
    && Date.parse(row.ts) >= Date.parse(witness.sentAt)
    && deliveries.some(delivery => String(delivery.id) === String(row.deliveryId)));
  expect(native, 'queueing, injection, current activity, or an unrelated native turn is insufficient').toBeTruthy();
  const delivery = deliveries.find(row => String(row.id) === String(native.deliveryId));
  correlate(witness, delivery, native);
  expect(() => correlate(witness, { ...delivery, payload: { msg_id: 'wrong-message' } }, native)).toThrow();
  expect(() => correlate(witness, { ...delivery, subscriber_id: 'su-wrong-recipient' }, native)).toThrow();
  expect(() => correlate(witness, delivery, { ...native, deliveryId: 'unrelated-turn' })).toThrow();
  console.info('PORTAL_NATIVE_PICKUP_OBSERVED ' + JSON.stringify({ owner, msgId: witness.msgId,
    deliveryId: delivery!.id, nativeStartedAt: native.ts, servingBuild: witness.servingBuild,
    hostEventsPath: nativeHostEvents, recordedHostEventsPath: witness.hostEventsPath }));
}, 30_000);

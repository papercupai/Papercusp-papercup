/** Current-host acceptance: explicit owned fixture coordinates, no automatic submissions. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { bridgeEval } from '../../../../libs/generic/tauri-verify/src/bridge-client';
import { executeOperationalRun } from '../agent-tools/testing/record-run';
import { activeWorkspaceId } from '../workspace-registry';
import { fileURLToPath } from 'node:url';

type Profile = {
  tauriPID: number;
  runtimeUnits?: string[];
  email: { origin: string; messageId: string; receiptId: number; targetId: string; nativeUrl: string; body: string };
  calendar: { origin: string; eventId: string; requestKey: string; trigger: unknown; nativeUrl: string; body: string };
  phone: { origin: string; bookingId: string; receiptId: number; booking: { requestKey: string }; nativeUrl: string; body: string };
};
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
let profile: Profile;
async function json(url: string, body?: unknown) {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(response.ok, `${url}: ${response.status}`).toBe(true);
  const value = await response.json();
  expect(value.ok).toBe(true);
  return value;
}
async function nativeBody(url: string, expected: string) {
  const config = { tauriPID: profile.tauriPID };
  const navigation = await bridgeEval(config, `location.assign(${JSON.stringify(url)}); true`);
  expect(navigation.ok, navigation.ok ? undefined : `${navigation.code}: ${navigation.error}`).toBe(true);
  await expect.poll(async () => {
    const observed = await bridgeEval<string>(config, 'JSON.stringify({href:location.href,text:document.body.innerText})');
    if (!observed.ok) return false;
    const value = JSON.parse(observed.value);
    return value.href === url && value.text.includes(expected);
  }, { timeout: 15000, interval: 500 }).toBe(true);
}

describe.skipIf(!profilePath)('accepted app operations on an explicitly selected live host', () => {
  beforeAll(async () => {
    // test:file executes from this package; profile coordinates are repo-relative.
    profile = JSON.parse(readFileSync(new URL(profilePath!, new URL('../../../../', import.meta.url)), 'utf8'));
    expect(profile.tauriPID).toBeGreaterThan(0);
    for (const app of [profile.email, profile.calendar, profile.phone]) {
      expect(new URL(app.origin).hostname).toBe('127.0.0.1');
      expect(new URL(app.nativeUrl).hostname).toBe('127.0.0.1');
      expect(app.body.length).toBeGreaterThan(20);
    }
    expect(profile.phone.booking.requestKey).toMatch(/^p010-restart-/);
    expect(profile.calendar.eventId).toMatch(/^p010-restart-/);
    // A live native process is insufficient: its authenticated bridge must
    // be discoverable before replaying any of the owned app requests.
    const bridge = await bridgeEval({ tauriPID: profile.tauriPID }, 'true');
    expect(bridge.ok, bridge.ok ? undefined : `${bridge.code}: ${bridge.error}`).toBe(true);
  });

  it('Email preserves its accepted task on replay and shows the actual ready proposal in Tauri', async () => {
    const app = profile.email;
    const url = `${app.origin}/api/messages/${encodeURIComponent(app.messageId)}/draft-reply`;
    const before = await json(`${app.origin}/api/drafts`);
    const replay = await json(url, {});
    expect(replay.handle.receiptId).toBe(app.receiptId);
    expect(replay.handle.target.id).toBe(app.targetId);
    const { draftReply } = await json(url);
    expect(draftReply.status).toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(draftReply.result.state).toBe('ready');
    expect(draftReply.result.output.proposals.some((p: { text: string }) => p.text.includes(app.body))).toBe(true);
    expect((await json(`${app.origin}/api/drafts`)).drafts).toEqual(before.drafts);
    await nativeBody(app.nativeUrl, app.body);
  }, 30000);

  it('Calendar deduplicates its event revision and shows the actual preparation in Tauri', async () => {
    const app = profile.calendar;
    expect((await json(`${app.origin}/api/triggers/calendar`, app.trigger)).deduplicated).toBe(true);
    const { status } = await json(`${app.origin}/api/meeting-prep/status?eventId=${encodeURIComponent(app.eventId)}`);
    expect(status).toMatchObject({ phase: 'ready', current: true, requestKey: app.requestKey });
    expect(status.brief.eventId).toBe(app.eventId);
    const { events } = await json(`${app.origin}/api/events`);
    expect(events.filter((e: { id: string }) => e.id === app.eventId)).toHaveLength(1);
    await nativeBody(app.nativeUrl, app.body);
  }, 30000);

  it('Phone preserves one booking and a ready brief without a dial or session in Tauri', async () => {
    const app = profile.phone;
    expect((await json(`${app.origin}/api/scheduled`, app.booking)).scheduled.id).toBe(app.bookingId);
    const { scheduled } = await json(`${app.origin}/api/scheduled`);
    const matches = scheduled.filter((b: { requestKey: string }) => b.requestKey === app.booking.requestKey);
    expect(matches).toHaveLength(1);
    const unit = matches[0].callUnit;
    expect(unit.brief.status).toBe('succeeded');
    expect(unit.brief.handle.receiptId).toBe(app.receiptId);
    expect(unit.brief.result).toContain(app.body);
    expect(unit.dialClaimedAt).toBeNull();
    expect(unit.sessionStartedAt).toBeNull();
    expect(unit.callId).toBeNull();
    await nativeBody(app.nativeUrl, app.body);
  }, 30000);

  it('rejects unknown message and event identities instead of exposing another completed operation', async () => {
    // These identities are derived from the owned inputs, never from result output.
    // A ready-result cache keyed only by operation name would leak the positive
    // cases above into these requests and must fail this counterexample.
    const missingMessage = `${profile.email.messageId}-not-submitted`;
    const missingEvent = `${profile.calendar.eventId}-not-submitted`;
    for (const [url, error] of [
      [`${profile.email.origin}/api/messages/${encodeURIComponent(missingMessage)}/draft-reply`,
        `email_message_not_found:${missingMessage}`],
      [`${profile.calendar.origin}/api/meeting-prep/status?eventId=${encodeURIComponent(missingEvent)}`,
        `calendar_event_not_found:${missingEvent}`],
    ]) {
      const response = await fetch(url);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error });
    }
  }, 30000);

  it('records a fresh native operational probe of the actual app results and Tauri runtime cohort', async () => {
    // Selectors are required, but no fingerprint is accepted from this fixture.
    // This is a NEW stable result/display probe, never a restamp of the manual
    // mid-task restart artifact or an invented test layer for that artifact.
    expect(profile.runtimeUnits, 'Select the actual app/operator/Tauri runtime cohort').toBeDefined();
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const result = await executeOperationalRun({
      filePath: 'packages/operator-core/lib/blueprint/app-operation-results.live.e2e.test.ts',
      name: 'P010 fresh native operational result/display probe', framework: 'operational',
      command: ['npm', 'run', 'test:file', '--',
        'packages/operator-core/lib/blueprint/app-operation-results.live.e2e.test.ts'],
      runtimeUnits: profile.runtimeUnits!,
      run: async () => {
        const email = await json(`${profile.email.origin}/api/messages/${encodeURIComponent(profile.email.messageId)}/draft-reply`);
        expect(email.draftReply.status).toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
        expect(email.draftReply.result.output.proposals.some((p: { text: string }) => p.text.includes(profile.email.body))).toBe(true);
        const calendar = await json(`${profile.calendar.origin}/api/meeting-prep/status?eventId=${encodeURIComponent(profile.calendar.eventId)}`);
        expect(calendar.status).toMatchObject({ phase: 'ready', current: true, requestKey: profile.calendar.requestKey });
        const phone = await json(`${profile.phone.origin}/api/scheduled`);
        const booking = phone.scheduled.find((b: { id: string }) => b.id === profile.phone.bookingId);
        expect(booking.callUnit.brief.status).toBe('succeeded');
        expect(booking.callUnit.brief.result).toContain(profile.phone.body);
        expect(booking.callUnit.dialClaimedAt).toBeNull();
        expect(booking.callUnit.sessionStartedAt).toBeNull();
        expect(booking.callUnit.callId).toBeNull();
        for (const app of [profile.email, profile.calendar, profile.phone]) await nativeBody(app.nativeUrl, app.body);
        return { exitCode: 0, summary: 'Fresh API result and native display assertions passed for Email, Calendar and Phone.',
          assertions: ['email-result-native-display', 'calendar-result-native-display', 'phone-result-native-display']
            .map(id => ({ id, passed: true, evidence: 'Actual local app result and Tauri body asserted during this execution.' })) };
      },
    }, { workspaceId: activeWorkspaceId(), harnessSlug: 'papercusp', projectDir: root });
    expect(result).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
    expect(result.testRunIds).toHaveLength(1);
    console.info('P010_NATIVE_OPERATIONAL_RUN', JSON.stringify(result));
  }, 60000);
});

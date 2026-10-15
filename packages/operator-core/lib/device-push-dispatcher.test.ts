import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  buildFcmMessage,
  resolveFcmCreds,
  pushEnabled,
  dispatchPush,
  isFcmTokenPermanentlyInvalid,
  isApnsTokenPermanentlyInvalid,
  tokensToReap,
  __resetPushCredsForTest,
} from './device-push-dispatcher';

const ENV_KEYS = [
  'FCM_SERVICE_ACCOUNT_PATH',
  'FCM_OAUTH_TOKEN',
  'FCM_PROJECT_ID',
  'APNS_AUTH_TOKEN',
  'APNS_KEY_PATH',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
];

let saved: Record<string, string | undefined>;
let dir: string;

function writeFakeServiceAccount(path: string, projectId = 'test-project') {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(
    path,
    JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key: privateKey,
      client_email: 'fbadmin@test-project.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  );
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __resetPushCredsForTest();
  // The dispatcher warns (once) when push is unconfigured/misconfigured — expected
  // in these tests; silence it so the repo's fail-on-console guard doesn't trip.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), 'push-test-'));
  // Point FCM at a nonexistent path so the real ~/.papercusp default never leaks in.
  process.env.FCM_SERVICE_ACCOUNT_PATH = join(dir, 'does-not-exist.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetPushCredsForTest();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('device-push-dispatcher', () => {
  it.each([1, 2])('composes a session message into exactly one provider request per %i capable device (R-10)', async (count) => {
    const capable = [
      { deviceId: 'android-a', platform: 'fcm' as const, token: 'android-token-a' },
      { deviceId: 'iphone-b', platform: 'apns' as const, token: 'iphone-token-b' },
    ].slice(0, count);
    const delivered: Array<{ deviceId: string; payload: unknown }> = [];
    const record = (token: string, payload: unknown) => {
      const device = capable.find(row => row.token === token);
      expect(device, 'provider received an unexpected recipient token').toBeDefined();
      delivered.push({ deviceId: device!.deviceId, payload });
    };
    const targets = vi.fn(async () => capable.map(({ platform, token }) => ({ platform, token })));
    vi.doMock('./device-store', () => ({ pushTargetsForWorkspace: targets, deletePushToken: vi.fn() }));
    vi.doMock('./owner-sessions/roster', () => ({ readSessionRosterSnapshot: async () => ({
      active: [{ ownerId: 'su-target', workspaceId: 'ws-a', role: 'su' }], starting: [], pending: [],
    }) }));
    vi.doMock('node:http2', () => ({ connect: () => Object.assign(new EventEmitter(), {
      close: vi.fn(),
      request: (headers: Record<string, string>) => Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        write: (body: string) => record(headers[':path']!.slice('/3/device/'.length), JSON.parse(body)),
        end(this: EventEmitter) { queueMicrotask(() => { this.emit('response', { ':status': 200 }); this.emit('end'); }); },
      }),
    }) }));
    vi.stubGlobal('fetch', vi.fn(async (url: string, request: RequestInit) => {
      expect(url).toBe('https://fcm.googleapis.com/v1/projects/phone-cardinality/messages:send');
      const payload = JSON.parse(String(request.body));
      record(payload.message.token, payload);
      return new Response('{}', { status: 200 });
    }));
    vi.resetModules();
    try {
      const serviceAccount = join(dir, 'cardinality-sa.json');
      writeFakeServiceAccount(serviceAccount, 'phone-cardinality');
      process.env.FCM_SERVICE_ACCOUNT_PATH = serviceAccount;
      process.env.APNS_AUTH_TOKEN = 'fixture-apns-auth';
      const dispatcher = await import('./device-push-dispatcher');
      vi.spyOn(dispatcher.resolveFcmCreds()!, 'getAccessToken').mockResolvedValue('fixture-fcm-auth');
      const { notifySessionOwnerMessage } = await import('./session-push');
      await notifySessionOwnerMessage({ msg_id: 'message-cardinality', from: 'su-target', to: ['human'],
        kind: 'message', ts: new Date().toISOString(), summary: 'Please review' }, 'ws-a');
      expect(targets).toHaveBeenCalledExactlyOnceWith('ws-a', 'agent-sessions');
      expect(delivered.map(row => row.deviceId).sort()).toEqual(capable.map(row => row.deviceId).sort());
      for (const device of capable) expect(delivered.filter(row => row.deviceId === device.deviceId)).toHaveLength(1);
      for (const row of delivered) expect(JSON.stringify(row.payload)).toContain('agent-session');
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('./device-store');
      vi.doUnmock('./owner-sessions/roster');
      vi.doUnmock('node:http2');
      vi.resetModules();
    }
  });

  it('buildFcmMessage produces the FCM v1 shape with HIGH android priority', () => {
    const msg = buildFcmMessage('device-token-123', {
      title: 'Needs you',
      body: 'A work item is waiting for approval',
      data: { kind: 'intervention', harness: 'papercusp' },
    });
    expect(msg.message.token).toBe('device-token-123');
    expect(msg.message.notification).toEqual({
      title: 'Needs you',
      body: 'A work item is waiting for approval',
    });
    expect(msg.message.data).toEqual({ kind: 'intervention', harness: 'papercusp' });
    expect(msg.message.android.priority).toBe('HIGH');
  });

  it('resolveFcmCreds returns null when the service account file is missing', () => {
    expect(resolveFcmCreds()).toBeNull();
  });

  it('resolveFcmCreds loads a valid service account and exposes projectId + token minter', () => {
    const path = join(dir, 'sa.json');
    writeFakeServiceAccount(path, 'papercusp-mobile');
    process.env.FCM_SERVICE_ACCOUNT_PATH = path;
    __resetPushCredsForTest();
    const creds = resolveFcmCreds();
    expect(creds).not.toBeNull();
    expect(creds!.projectId).toBe('papercusp-mobile');
    expect(typeof creds!.getAccessToken).toBe('function');
  });

  it('resolveFcmCreds returns null when the service account is missing required fields', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ project_id: 'x' })); // no client_email/private_key
    process.env.FCM_SERVICE_ACCOUNT_PATH = path;
    __resetPushCredsForTest();
    expect(resolveFcmCreds()).toBeNull();
  });

  it('pushEnabled reflects actual configuration', () => {
    // FCM unconfigured (bogus path), APNs unconfigured
    expect(pushEnabled()).toEqual({ fcm: false, apns: false });

    // APNs via an explicit pre-signed token
    process.env.APNS_AUTH_TOKEN = 'pre-signed-jwt';
    expect(pushEnabled().apns).toBe(true);
    delete process.env.APNS_AUTH_TOKEN;

    // APNs via key material trio
    process.env.APNS_KEY_PATH = '/tmp/AuthKey.p8';
    process.env.APNS_KEY_ID = 'ABC123';
    process.env.APNS_TEAM_ID = 'TEAM123';
    expect(pushEnabled().apns).toBe(true);

    // FCM configured
    const path = join(dir, 'sa.json');
    writeFakeServiceAccount(path);
    process.env.FCM_SERVICE_ACCOUNT_PATH = path;
    __resetPushCredsForTest();
    expect(pushEnabled().fcm).toBe(true);
  });

  it('dispatchPush cleanly SKIPS unconfigured providers (never throws)', async () => {
    const results = await dispatchPush(
      [
        { platform: 'fcm', token: 'fcm-tok' },
        { platform: 'apns', token: 'apns-tok' },
      ],
      { title: 't', body: 'b', data: { kind: 'smoke-fail' } },
    );
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.platform === 'fcm')).toMatchObject({ ok: false, status: 'skipped' });
    expect(results.find((r) => r.platform === 'apns')).toMatchObject({ ok: false, status: 'skipped' });
  });
});

/**
 * WI-37482 — a CONFIGURED-BUT-BROKEN provider must not report as an unconfigured host.
 *
 * ⚠ Note what this suite can and cannot do. The original fault was a bare CJS `require()` in an
 * ESM module, and it is INVISIBLE to vitest: the module runner defines `require`, so the
 * pre-existing "pushEnabled() is true with a valid service account" test exercised this exact
 * path and passed, while the real ESM host (bg-host, via tsx) threw `require is not defined` on
 * every push for the entire audited window. A runtime test cannot reproduce a fault that only
 * exists under the host's module semantics — so the require itself is locked by a SOURCE
 * assertion, and the runtime tests below lock the reporting that let it hide.
 */
describe('FCM credential faults report as faults, not skips (WI-37482)', () => {
  it('source carries no bare require() — it is not defined in the ESM hosts that serve pushes', () => {
    const src = readFileSync(fileURLToPath(new URL('./device-push-dispatcher.ts', import.meta.url)), 'utf8');
    // `requireCjs(` (createRequire) is correct; a bare `require(` is the bug.
    expect(src).not.toMatch(/[^a-zA-Z.]require\s*\(/);
    expect(src).toContain('createRequire(import.meta.url)');
  });

  it('an ABSENT service account is a silent skip — most hosts never configure push', async () => {
    process.env.FCM_SERVICE_ACCOUNT_PATH = join(dir, 'nope.json');
    __resetPushCredsForTest();
    const [r] = await dispatchPush([{ platform: 'fcm', token: 't' }], {
      title: 't',
      body: 'b',
      data: { kind: 'intervention' },
    });
    expect(r).toMatchObject({ ok: false, status: 'skipped' });
    expect(r.detail).toBeUndefined();
  });

  it('a PRESENT but unusable service account is an ERROR carrying the cause', async () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ this is not valid json');
    process.env.FCM_SERVICE_ACCOUNT_PATH = path;
    __resetPushCredsForTest();
    const [r] = await dispatchPush([{ platform: 'fcm', token: 't' }], {
      title: 't',
      body: 'b',
      data: { kind: 'intervention' },
    });
    // The whole point: NOT 'skipped'. A broken credential must be distinguishable from a host
    // that simply has no phone paired — that conflation hid 91 of 141 failed pushes.
    expect(r.status).toBe('error');
    expect(r.detail).toContain('broken.json');
  });
});

/**
 * WI-37477 — reaping a token the provider says is permanently dead.
 *
 * The property under test is ASYMMETRIC: failing to reap costs a wasted push, reaping wrongly
 * DELETES a live device's only address. So every case below that is not the documented
 * UNREGISTERED contract is asserted NOT to reap — those are the controls, and they are the
 * point of the suite.
 */
describe('stale FCM token reaping (WI-37477)', () => {
  const UNREGISTERED_BODY = JSON.stringify({
    error: {
      code: 404,
      message: 'NotRegistered',
      status: 'NOT_FOUND',
      details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
    },
  });

  it('recognises the real production 404 body as permanently invalid', () => {
    expect(isFcmTokenPermanentlyInvalid(404, UNREGISTERED_BODY)).toBe(true);
  });

  it('recognises the legacy NotRegistered message without an errorCode block', () => {
    expect(isFcmTokenPermanentlyInvalid(404, '{"error":{"message":"NotRegistered"}}')).toBe(true);
  });

  // ── Controls: none of these may authorise a delete ──────────────────────────
  it('does NOT reap a transient failure, however it presents', () => {
    // A 5xx whose body happens to mention the word — status and error code must AGREE.
    expect(isFcmTokenPermanentlyInvalid(503, UNREGISTERED_BODY)).toBe(false);
    expect(isFcmTokenPermanentlyInvalid(500, 'internal error')).toBe(false);
    expect(isFcmTokenPermanentlyInvalid(401, 'auth expired')).toBe(false);
    // A 404 that is NOT the unregistered contract (e.g. a wrong project id in the URL).
    expect(isFcmTokenPermanentlyInvalid(404, '{"error":{"message":"Requested entity was not found."}}')).toBe(false);
    expect(isFcmTokenPermanentlyInvalid(404, '')).toBe(false);
    // An unconfigured provider is the single most common `ok:false` on this box today.
    expect(isFcmTokenPermanentlyInvalid('skipped', UNREGISTERED_BODY)).toBe(false);
    expect(isFcmTokenPermanentlyInvalid('error', UNREGISTERED_BODY)).toBe(false);
  });

  it('tokensToReap selects only the unregistered targets, by index', () => {
    const targets = [
      { platform: 'fcm' as const, token: 'live' },
      { platform: 'fcm' as const, token: 'dead' },
      { platform: 'apns' as const, token: 'transient' },
    ];
    const results = [
      { platform: 'fcm' as const, ok: true, status: 200 },
      { platform: 'fcm' as const, ok: false, status: 404, unregistered: true },
      { platform: 'apns' as const, ok: false, status: 503 },
    ];
    expect(tokensToReap(targets, results).map((t) => t.token)).toEqual(['dead']);
  });

  it('tokensToReap fails CLOSED when the arrays disagree in length', () => {
    // A shifted index would delete the WRONG live device's token — strictly worse than
    // leaving a dead one registered, so a broken correspondence must reap nothing.
    const targets = [
      { platform: 'fcm' as const, token: 'a' },
      { platform: 'fcm' as const, token: 'b' },
    ];
    expect(tokensToReap(targets, [{ platform: 'fcm', ok: false, status: 404, unregistered: true }])).toEqual([]);
  });

  it('notifyWorkspace forwards the required session capability to the workspace target query', async () => {
    const targets = vi.fn().mockResolvedValue([]);
    vi.doMock('./device-store', () => ({ pushTargetsForWorkspace: targets, deletePushToken: vi.fn() }));
    vi.resetModules();
    const { notifyWorkspace } = await import('./device-push-dispatcher');
    expect(await notifyWorkspace('ws-a', { title: 'Agent message', body: 'Review requested', data: { kind: 'agent-session' } },
      { requiredCapability: 'agent-sessions' })).toEqual([]);
    expect(targets).toHaveBeenCalledOnce();
    expect(targets).toHaveBeenCalledWith('ws-a', 'agent-sessions');
    vi.doUnmock('./device-store');
    vi.resetModules();
  });

  it('notifyWorkspace DELETES an unregistered token and leaves the healthy ones alone', async () => {
    const deleted: string[] = [];
    vi.doMock('./device-store', () => ({
      pushTargetsForWorkspace: async () => [
        { platform: 'fcm', token: 'live-token' },
        { platform: 'fcm', token: 'dead-token' },
      ],
      deletePushToken: async (_ws: string, token: string) => {
        deleted.push(token);
      },
    }));
    vi.resetModules();
    const mod = await import('./device-push-dispatcher');
    const results = await mod.notifyWorkspace(
      'papercusp-workspace',
      { title: 't', body: 'b', data: { kind: 'intervention' } },
      {
        dispatch: async (targets) =>
          targets.map((t) =>
            t.token === 'dead-token'
              ? { platform: 'fcm' as const, ok: false, status: 404, unregistered: true }
              : { platform: 'fcm' as const, ok: true, status: 200 },
          ),
      },
    );
    expect(results).toHaveLength(2);
    expect(deleted).toEqual(['dead-token']);
    vi.doUnmock('./device-store');
    vi.resetModules();
  });
});

/**
 * The APNs half (EI-19976889768364098). `tokensToReap` was already provider-agnostic — it
 * filters on `unregistered === true` regardless of platform — so FCM tokens were reaped and
 * APNs tokens never were, purely because `sendApns` never set the flag. The asymmetry was
 * latent only because APNs is dormant until Apple Developer enrollment; it would have gone
 * live silently, at enrollment, when nobody was looking at this file.
 *
 * The controls carry the real weight here. `BadDeviceToken` / `DeviceTokenNotForTopic` are
 * CONFIGURATION errors (wrong `APNS_HOST`, wrong `APNS_BUNDLE_ID`) that every live token
 * reports at once, so treating them as terminal would delete the entire iOS fleet's tokens on
 * a single bad env var. They must never reap.
 */
describe('stale APNs token reaping (EI-19976889768364098)', () => {
  const UNREGISTERED_BODY = JSON.stringify({ reason: 'Unregistered', timestamp: 1712000000000 });

  it('recognises the documented 410 Unregistered response as permanently invalid', () => {
    expect(isApnsTokenPermanentlyInvalid(410, UNREGISTERED_BODY)).toBe(true);
  });

  // ── Controls: none of these may authorise a delete ──────────────────────────
  it('does NOT reap a CONFIGURATION error, however terminal it looks', () => {
    // Wrong APNS_HOST (prod token → sandbox, or the reverse). Every live token reports this.
    expect(isApnsTokenPermanentlyInvalid(400, '{"reason":"BadDeviceToken"}')).toBe(false);
    // Wrong APNS_BUNDLE_ID. Also fleet-wide, also recoverable by fixing the env var.
    expect(isApnsTokenPermanentlyInvalid(400, '{"reason":"DeviceTokenNotForTopic"}')).toBe(false);
  });

  it('does NOT reap a transient failure, however it presents', () => {
    // Status and reason must AGREE — a body mentioning the word is not enough.
    expect(isApnsTokenPermanentlyInvalid(503, UNREGISTERED_BODY)).toBe(false);
    expect(isApnsTokenPermanentlyInvalid(500, 'internal server error')).toBe(false);
    expect(isApnsTokenPermanentlyInvalid(403, '{"reason":"ExpiredProviderToken"}')).toBe(false);
    // A 410 that is NOT the documented contract, and an empty body.
    expect(isApnsTokenPermanentlyInvalid(410, '{"reason":"PayloadTooLarge"}')).toBe(false);
    expect(isApnsTokenPermanentlyInvalid(410, '')).toBe(false);
    // An unconfigured provider is the ONLY ok:false APNs sees today (dormant until enrollment).
    expect(isApnsTokenPermanentlyInvalid('skipped', UNREGISTERED_BODY)).toBe(false);
    expect(isApnsTokenPermanentlyInvalid('error', UNREGISTERED_BODY)).toBe(false);
  });

  it('does NOT share the FCM terminal status — 404 means a malformed :path on APNs', () => {
    // The two classifiers must not be collapsed: 404 is terminal for FCM, benign for APNs.
    expect(isApnsTokenPermanentlyInvalid(404, '{"reason":"BadPath"}')).toBe(false);
    expect(isFcmTokenPermanentlyInvalid(410, UNREGISTERED_BODY)).toBe(false);
  });

  it('reaps a dead APNs token through the same provider-agnostic path as FCM', () => {
    const targets = [
      { platform: 'apns' as const, token: 'ios-live' },
      { platform: 'apns' as const, token: 'ios-dead' },
      { platform: 'fcm' as const, token: 'android-live' },
    ];
    const results = [
      { platform: 'apns' as const, ok: false, status: 400, detail: '{"reason":"BadDeviceToken"}' },
      { platform: 'apns' as const, ok: false, status: 410, unregistered: true },
      { platform: 'fcm' as const, ok: true, status: 200 },
    ];
    // The misconfigured-but-live iOS token survives; only the genuinely dead one is reaped.
    expect(tokensToReap(targets, results).map((t) => t.token)).toEqual(['ios-dead']);
  });
});

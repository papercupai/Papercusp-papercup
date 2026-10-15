/**
 * The phone's device API surface that may be reached from outside the machine
 * (EI-24788399827381729, plan android-public-release-2026-10-01 D-013 #2).
 *
 * ONE list, read by both remote doors so they cannot drift apart:
 *  - the external-ingress listener a user's own tunnel points at
 *    (apps/operator/bin/external-ingress-paths.ts), and
 *  - the hosted portal's `device-http` relay plane
 *    (workspace-host/hosted-app-relay.ts), which carries a phone's call to a
 *    cloud workspace over the workspace's outbound connector.
 *
 * Pair redeems a desktop-minted one-use secret; every other listed route requires a
 * device JWT, checked on the machine. Never allow `/api/device/*` wholesale: desktop
 * mint/list/revoke and the public QR renderer must stay unreachable from outside.
 * Exact paths, plus a few id-bearing SHAPES, never a prefix.
 */

/** The one route a phone calls before it holds a device JWT. */
export const PHONE_DEVICE_PAIR_PATH = '/api/device/pair';

export const PHONE_DEVICE_PATHS = [
  PHONE_DEVICE_PAIR_PATH, '/api/device/workspace/switch', '/api/device/devices',
  '/api/device/runtime-config', '/api/device/workspaces', '/api/device/heartbeat',
  '/api/device/rest-query', '/api/device/attention', '/api/device/monitoring',
  '/api/device/harnesses', '/api/device/running', '/api/device/push/register',
  '/api/device/notifications/recent', '/api/device/actions/recent',
  '/api/device/operator/pause', '/api/device/operator/cards',
  '/api/device/operator/standing-candidates', '/api/device/operator/standing-candidates/decide',
  '/api/device/operator/conversation', '/api/device/operator/conversation/turns', '/api/device/operator/converse',
  '/api/device/plans', '/api/device/sessions', '/api/device/voice-lease', '/api/device/voice-lease/claim',
  '/api/device/voice-lease/heartbeat', '/api/device/voice-session-init',
  '/api/device/voice/turn', '/api/device/voice/warmup',
] as const;

export const PHONE_DEVICE_PATH_SHAPES: ReadonlyArray<RegExp> = [
  /^\/api\/device\/sessions\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/(?:transcript|messages|end)$/,
  /^\/api\/device\/devices\/[A-Za-z0-9_-]+$/,
  /^\/api\/device\/harnesses\/[A-Za-z0-9._-]+(?:\/(?:replan|smoke-test|cleanup|log\/stream))?$/,
  /^\/api\/device\/plans\/[A-Za-z0-9._-]+(?:\/items\/P-\d{3,}\/status)?$/,
  /^\/api\/device\/voice-tool\/[A-Za-z0-9._-]+$/,
];

/** The HTTP methods the phone device routes use (routes/device/*.ts). */
export const PHONE_DEVICE_METHODS = ['GET', 'POST', 'DELETE'] as const;

const PHONE_DEVICE_PATH_SET: ReadonlySet<string> = new Set(PHONE_DEVICE_PATHS);

/** Whether `pathname` (no query, no trailing slash) is a phone device route. */
export function isPhoneDevicePath(pathname: string): boolean {
  return PHONE_DEVICE_PATH_SET.has(pathname) || PHONE_DEVICE_PATH_SHAPES.some((pattern) => pattern.test(pathname));
}

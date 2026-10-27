/**
 * Regression guard for the D3 auth-tightening pass.
 *
 * The migration ported every route at its "current posture" (D3 of
 * `endpoint-route-migration-2026-05-20`); the D3 pass tightened
 * sensitive routes that had no auth check pre-migration. The desktop
 * UI auto-establishes a passwordless `verified` session via the first
 * `/api/auth/me` hit (auth.ts → auth/me.ts), so `verified` is the
 * real-world UI trust level — gating to `{trust:['verified','trusted']}`
 * defends sensitive surfaces against CSRF / DNS-rebinding from cookie-
 * less origins while still letting the chrome's same-origin fetches
 * and the SU bearer through.
 *
 * This test pins the resulting tiering. It fails if any route in a
 * sensitive family drifts back to `'public'`, and it fails if a route
 * that MUST stay public (OAuth redirects, unauth probes) is tightened.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ROUTES } from '../routes';
import type { RouteAuth } from '@papercusp/agent-mcp';

const attentionBulkResolveSrc = readFileSync(join(__dirname, '../routes/admin/attention-bulk-resolve.ts'), 'utf8');

const VT = { trust: ['verified', 'trusted'] } as const;
// VT + bare loopback. The D3 rationale above assumed the desktop webview
// holds a verified session from /api/auth/me's auto-login — in practice the
// webview's /api traffic rides the sys:http IPC bridge where cookies don't
// exist (EI-338). On the bridge the injected loopback-superuser bearer
// resolves `trusted` (live-verified 2026-06-12: VT route 200 via socket,
// 403 via bare HTTP) — but during the documented HTTP-FALLBACK windows
// (dev no-sidecar, prod pre-IPC-handshake, IPC down) the webview fetches
// natively with no bearer, resolves `unverified-loopback`, and a VT gate
// silently 403-blanks the settings UI (found 2026-06-11). These families
// admit unverified-loopback for that fallback path, backstopped by the
// requireAllowedOriginOr403 CSRF guard on every mutating handler.
// Re-tighten to VT only when the native-HTTP fallback path is retired —
// NOT on cookie persistence, which can never apply to IPC traffic.
const VTL = { trust: ['verified', 'trusted', 'unverified-loopback'] } as const;
const T_ONLY = { trust: ['trusted'] } as const;

function describeAuth(a: RouteAuth): string {
  if (a === 'public') return "'public'";
  if (!a || Object.keys(a).length === 0) return '{}';
  return JSON.stringify(a);
}

/**
 * Per-family expected tier. Routes whose path starts with `prefix` must
 * have an `auth` equal to `expect` — unless the (method, path) appears
 * in `exceptions` (rare pre-existing tiers that D3 didn't reconcile).
 */
const RULES: ReadonlyArray<{
  prefix: string;
  expect: RouteAuth;
  exceptions?: ReadonlyArray<{ method: string; path: string; auth: RouteAuth }>;
}> = [
  {
    prefix: '/dev/',
    expect: VT,
    exceptions: [
      // Same EI-338 cookie-less desktop-webview rationale as its /admin/ VTL
      // siblings: TableAdmin's Promise.all also fetches this alongside
      // /admin/tables/:exportName, so leaving it VT still 403-blanked the
      // pane (EI-18834967602055309). Read-only schema introspection.
      { method: 'GET', path: '/dev/tables/:exportName', auth: VTL },
    ],
  },
  { prefix: '/credentials', expect: VTL },
  { prefix: '/publish-credentials', expect: VTL },
  {
    prefix: '/agent-tokens/',
    expect: VT,
    exceptions: [
      // The refresh token (Authorization: Bearer) IS the credential, read in
      // the handler — and during refresh the access token has expired by
      // definition, so there's no verified/trusted transport principal to gate
      // on. `auth: {}` per the route's doc-comment; VT 403'd every legitimate
      // refresh (the same Authorization header can't be both a trusted-principal
      // bearer and the refresh token).
      { method: 'POST', path: '/agent-tokens/power-user/refresh', auth: {} },
    ],
  },
  { prefix: '/provision/', expect: VT },
  {
    prefix: '/internal/',
    expect: {},
    exceptions: [
      // Dependency-free watchdog self-report sink (fleet-reliability-
      // verification-2026-07-10 P-008): the callers are plain-`node` watchdog
      // scripts with no principal token to present, so `auth: {}` (any
      // caller) would work but is wider than needed — `'loopback'` rejects
      // non-loopback hosts at the route-stack auth chokepoint while still
      // requiring no token. See the route's own doc-comment.
      { method: 'POST', path: '/internal/runtime-vintage', auth: 'loopback' },
      // Deploy-triggered memory recall canary probe (EI-10361): the caller is
      // deploy-cli running on the same box (no principal token to present),
      // right after a restart — `'loopback'` rejects non-loopback hosts at the
      // route-stack auth chokepoint while still requiring no token. See the
      // route's own doc-comment (memory-canary-probe.ts).
      { method: 'POST', path: '/internal/memory-canary', auth: 'loopback' },
      // Deploy-triggered domain-read canary (same contract as memory-canary):
      // the caller is deploy-cli on the same box, no principal token —
      // `'loopback'` rejects non-loopback hosts while requiring no token. See
      // the route's own doc-comment (domain-read-canary.ts).
      { method: 'POST', path: '/internal/domain-read-canary', auth: 'loopback' },
      // schedule-federation timer probe: the ONLY caller is a sibling
      // operator-shaped process on the same box (bg-host, staging) asking this
      // process for its per-process managedSetInterval + DBOS registries, which
      // nothing can see from outside. Same contract as the three above — a
      // same-box caller with no principal token, so `'loopback'` rejects
      // non-loopback hosts at the route-stack chokepoint while requiring no
      // token. Strictly NARROWER than the family's `{}`. See the route's own
      // doc-comment (misc/managed-timers.ts).
      { method: 'GET', path: '/internal/managed-timers', auth: 'loopback' },
      // Per-process live flag attestation. The only callers are same-box
      // operator processes comparing one another's resolver/cache state.
      { method: 'GET', path: '/internal/flags-attest', auth: 'loopback' },
      // Live head-snapshot probe, same subsystem and same contract as
      // managed-timers directly above: the ONLY caller is
      // sync/hyperbee/live-head-snapshot-client.ts, which posts to
      // `http://127.0.0.1:${sibling.port}` — a sibling operator-shaped process
      // on THIS box, holding no principal token. `'loopback'` rejects
      // non-loopback hosts at the route-stack chokepoint while requiring no
      // token, so it is strictly NARROWER than the family's `{}`, not a
      // loosening. See the route's own doc-comment
      // (misc/substrate-head-snapshot.ts).
      { method: 'POST', path: '/internal/substrate/head-snapshot', auth: 'loopback' },
      // Requested own-log compaction (p2p-join-catchup-speed D-023): same holder
      // fan-out contract and same same-box-only caller as head-snapshot above.
      { method: 'POST', path: '/internal/substrate/own-compaction', auth: 'loopback' },
    ],
  },
  // The /api/tui/* workbench READS stay `auth:'public'` (loopback-protected by
  // the host bind, owner-scoped by an explicit `owner` arg; the intent-result/
  // stream routes additionally gate on `isLoopbackRequest` inline). The
  // MUTATING routes were hardened public → 'loopback' (auth-tier rollout,
  // 2026-06-11: the box is tunnel-exposed, so TUI writes must not ride the
  // public tier). This pins BOTH postures so neither drifts. Handler behavior
  // is covered by `tui-routes.test.ts`.
  {
    prefix: '/tui/',
    expect: 'public',
    exceptions: [
      { method: 'PUT', path: '/tui/view-state', auth: 'loopback' },
      { method: 'PUT', path: '/tui/layouts', auth: 'loopback' },
      { method: 'DELETE', path: '/tui/layouts/:name', auth: 'loopback' },
      { method: 'PUT', path: '/tui/crews', auth: 'loopback' },
      { method: 'DELETE', path: '/tui/crews/:name', auth: 'loopback' },
      { method: 'POST', path: '/tui/intents/:id/result', auth: 'loopback' },
      { method: 'POST', path: '/tui/plan-item-convert', auth: 'loopback' },
      { method: 'POST', path: '/tui/plan-item-release', auth: 'loopback' },
    ],
  },
  {
    prefix: '/admin/',
    expect: VT,
    exceptions: [
      // Customer-data support additionally requires a verified user and the
      // exact operation capability; the handler also verifies staff membership.
      { method: 'POST', path: '/admin/customer-data/export', auth: { kind: ['user'], trust: ['verified'], capabilities: ['customer-data:export'] } },
      { method: 'POST', path: '/admin/customer-data/deletion/recover', auth: { kind: ['user'], trust: ['verified'], capabilities: ['customer-data:deletion:recover'] } },
      // Pre-existing tier — faithful ports of routes that already required SU.
      { method: 'POST', path: '/admin/backup-orphan-cleanup', auth: T_ONLY },
      { method: 'POST', path: '/admin/embed-backfill', auth: T_ONLY },
      { method: 'GET', path: '/admin/spawn-signing/failures', auth: T_ONLY },
      { method: 'POST', path: '/admin/spawn-signing/rotate', auth: T_ONLY },
      // dbos/pipeline/start intentionally requires the stricter `trusted` tier
      // (not verified) — a deliberate stricter gate, like spawn-signing.
      { method: 'POST', path: '/admin/dbos/pipeline/start', auth: T_ONLY },
      // Deploy-accounts powers the settings UI from the cookie-less desktop
      // webview's HTTP-fallback path — admits unverified-loopback (see VTL).
      { method: 'GET', path: '/admin/deploy-accounts', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/register', auth: VTL },
      // One-click OAuth link start + completion (accounts-pool-tab-2026-06-15 P-002)
      // — both routes declare VTL with the SAME cookie-less desktop-webview rationale
      // (EI-338, "mirrors /register, /reset-rate") as its siblings here.
      { method: 'POST', path: '/admin/deploy-accounts/link-start', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/link-complete', auth: VTL },
      // link-status: the tab POLLS the held link while the owner approves in the browser —
      // claude CLI ≥2.1.200 auto-delivers the code to the held CLI on a same-machine approval,
      // so completion happens server-side with no pasted code (2026-07-03). Same cookie-less
      // desktop-webview rationale (EI-338) as its link-* siblings.
      { method: 'POST', path: '/admin/deploy-accounts/link-status', auth: VTL },
      // Session-now account override read/write (accounts-pool-tab P-004) — same
      // cookie-less desktop-webview rationale (EI-338) as its deploy-accounts siblings.
      { method: 'GET', path: '/admin/deploy-accounts/session-override', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/session-override', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/remove', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/reset-rate', auth: VTL },
      // The packaged desktop roster invokes coord writes from its cookie-less
      // loopback webview. Keep this exception pinned alongside the other
      // desktop-callable admin routes so a future auth sweep does not regress
      // the owner-local Send/Wake actions back to 403.
      { method: 'POST', path: '/admin/coord/:verb', auth: VTL },
      // GUI session chat's posture actions (Autonomy radio, Overlays
      // checkboxes — gui-chat-session-controls-2026-07-25 P-003/P-004) POST
      // here from the same cookie-less loopback webview as its /admin/coord/:verb
      // sibling immediately above — same EI-338 HTTP-fallback rationale, same
      // requireAllowedOriginOr403 CSRF backstop. See admin/mode.ts's own
      // doc-comment.
      { method: 'POST', path: '/admin/mode/:verb', auth: VTL },
      // The Accounts and Config tabs use the same cookie-less packaged-desktop
      // HTTP fallback as Mode. Both handlers apply requireAllowedOriginOr403
      // before dispatching their write verbs, so pin the same VTL posture here
      // instead of letting the family-wide VT default manufacture drift.
      { method: 'POST', path: '/admin/accounts/:verb', auth: VTL },
      { method: 'POST', path: '/admin/config/:verb', auth: VTL },
      // PlanAuditPane's start/history/report fetches use the same cookie-less
      // desktop fallback. The POST retains its CSRF guard; plan-audit.test.ts
      // exercises admission and denial through the production route stack.
      { method: 'POST', path: '/admin/plan-audit', auth: VTL },
      { method: 'GET', path: '/admin/plan-audit', auth: VTL },
      // The Goals tab's WRITE half posts from that same cookie-less loopback
      // webview as its /admin/mode/:verb sibling immediately above — which
      // admin/goals.ts is explicitly modelled on — so the same EI-338
      // HTTP-fallback rationale and the same requireAllowedOriginOr403 CSRF
      // backstop apply (declared at admin/goals.ts:131, guard applied in its
      // dispatch handler). See that route file's own doc-comment.
      { method: 'POST', path: '/admin/goals/:verb', auth: VTL },
      // Owner-Inbox reply delivery (owner-inbox-single-pane-2026-07-17 P-006):
      // invoked from the same cookie-less loopback webview as its
      // /admin/coord/:verb sibling above, so the same VTL posture. Because the
      // reply mints the `coord-inject:owner` turn-provenance origin, the
      // handler additionally carries the requireAllowedOriginOr403 CSRF
      // backstop (see the route file's own comments).
      { method: 'POST', path: '/admin/coord-inbox-reply', auth: VTL },
      // Inbox BULK RESOLVE is another owner-desktop write from that same
      // cookie-less HTTP-fallback path. The handler applies
      // requireAllowedOriginOr403 before its flag gate or any run mutation,
      // so keep the intentional VTL declaration explicit in this registry.
      { method: 'POST', path: '/admin/attention-bulk-resolve', auth: VTL },
      // Plans cleanup uses the same cookie-less desktop-webview POST path and
      // the same requireAllowedOriginOr403 CSRF backstop as Inbox bulk resolve.
      { method: 'POST', path: '/admin/plan-cleanup', auth: VTL },
      // The Plans pane completion form's submit (plan-item-types-registry-cupboard
      // -2026-10-20 P-007) posts from the same cookie-less desktop webview and
      // applies requireAllowedOriginOr403 before reading the body.
      { method: 'POST', path: '/admin/plan-item-type-fields', auth: VTL },
      // Inbox triage + the standing bulk automation policy (Settings > Autonomy,
      // the Plans pane) post from that same cookie-less desktop webview. VT 403'd
      // both in the shipping shell (webview-fetch-auth.test.ts, WI-6554700010009809);
      // the route's own model is "same posture as admin/coord", which is VTL.
      // dispatchWrite applies requireAllowedOriginOr403 before proxying any verb.
      { method: 'POST', path: '/admin/inbox/:verb', auth: VTL },
      // Same cookie-less desktop-webview HTTP-fallback path (EI-338): the
      // gateway rate/headroom stats view admits unverified-loopback (see the
      // route's own auth declaration in admin/inference-gateway-stats.ts).
      { method: 'GET', path: '/admin/inference-gateway/stats', auth: VTL },
      // The Task Manager's kill control (task-manager-no-escape-2026-07-27
      // P-023/P-024) — mounted in BOTH the AdvShell dropdown and the full page,
      // both of which post from that same cookie-less loopback webview, so VT
      // would 403 exactly where the owner asked for the control. It is a
      // DESTRUCTIVE route, so it carries requireAllowedOriginOr403 like its
      // /admin/mode/:verb sibling, and its payload is a `taskId` and nothing
      // else — there is no pid, name or pattern form. See the doc-comment in
      // admin/task-manager.ts.
      { method: 'POST', path: '/admin/tasks/kill', auth: VTL },
      // WI-6486 — same EI-338 cookie-less desktop-webview path, found by driving
      // the HUD in the Tauri shell: the conversation pane 403-blanked because
      // `sessions:list` (the owner→session lookup behind ?hudsession=) proxies
      // through here. That is load-bearing rather than cosmetic —
      // hud-consolidation-2026-07-26 D-001 RETIRED the sidebar Inbox on the
      // grounds that asks "now open as a HUD conversation instead", so the 403
      // left a human ask with no surface at all. Backstopped by the
      // requireAllowedOriginOr403 CSRF guard at the top of its dispatch, which is
      // what makes admitting a cookie-less caller safe on a proxy that reaches
      // write verbs (topics:create, conversations:post/answer/resolve, coord:ask).
      { method: 'POST', path: '/admin/coordination/:group/:verb', auth: VTL },
      // WI-6501 — the same EI-338 path, owner-reported from the left sidebar:
      // "plans:get → 403: trust unverified-loopback not in allowlist". The plans
      // rail is the primary navigation surface rather than an optional pane, so VT
      // here meant the sidebar was dead in the shipping (desktop) build.
      //
      // Widened rather than moved to sync queries because the plans client spans
      // ~30 verbs across BOTH reads and mutations, and useSyncQuery is a read
      // transport with no mutation path — that route would have fixed the reads and
      // left every write 403ing.
      //
      // The write half is backstopped by requireAllowedOriginOr403 at the top of
      // `dispatchWrite` (plans writes reach set-status / add-item / edit), which is
      // what makes admitting a cookie-less caller safe here.
      { method: 'GET', path: '/admin/plans/:verb', auth: VTL },
      { method: 'POST', path: '/admin/plans/:verb', auth: VTL },
      // Same cookie-less desktop-webview rationale (EI-338): the packaged Mac/
      // Windows desktop app hits this route as a diagnostic from localhost with
      // no session cookie to present (EI-8816) — see the route's own auth
      // comment in admin/dogfood-substrate-health.ts.
      { method: 'GET', path: '/admin/dogfood-substrate-health', auth: VTL },
      // (admin/plans.ts is now committed + gated to VT, so its prior deferred
      // 'public' exception was removed.)
      // owner-presence-human-turn-signal-2026-07-11 P-002: the psu pty-host hits
      // this fire-and-forget on every human keystroke from a cookie-less local
      // process (EI-338 rationale, same as its admin/ VTL siblings above). It
      // writes only a non-secret timestamp and is CSRF-guarded by
      // requireAllowedOriginOr403 — see the route's own auth comment in
      // admin/owner-presence-touch.ts.
      { method: 'POST', path: '/admin/owner-presence/touch', auth: VTL },
      // WI-6554700010011967: the psu pty-host reports quota starvation from the
      // same cookie-less local process; CSRF-guarded like owner-presence/touch,
      // and it can only fire a fleet health event.
      { method: 'POST', path: '/admin/psu-pty/quota-starvation', auth: VTL },
      // Same EI-338 cookie-less desktop-webview rationale as the VTL entries
      // above: AdminOps/TableAdmin/DbosClient/SchedulesClient bare-fetch these
      // from the packaged desktop app with no session cookie, so they only
      // ever resolve 'unverified-loopback' — VT silently 403-blanked all four
      // panes (EI-18834967602055309, measured live 2026-07-27). Read-only,
      // except tables/:exportName's mutating verbs, which are additionally
      // CSRF-guarded by requireAllowedOriginOr403 (see the route file).
      { method: 'GET', path: '/admin/commands', auth: VTL },
      { method: 'GET', path: '/admin/tables', auth: VTL },
      { method: 'GET', path: '/admin/tables/:exportName', auth: VTL },
      { method: 'POST', path: '/admin/tables/:exportName', auth: VTL },
      { method: 'PATCH', path: '/admin/tables/:exportName', auth: VTL },
      { method: 'DELETE', path: '/admin/tables/:exportName', auth: VTL },
      { method: 'GET', path: '/admin/dbos/status', auth: VTL },
      { method: 'GET', path: '/admin/schedules/inventory', auth: VTL },
      // External-trigger admin shares the same cookie-less owner desktop path.
      // PATCH is CSRF-guarded and additionally requires explicit owner confirm
      // for both arm and disarm mutations (admin/external-triggers.ts).
      { method: 'GET', path: '/admin/triggers', auth: VTL },
      { method: 'PATCH', path: '/admin/triggers', auth: VTL },
    ],
  },
];

/**
 * Routes that MUST stay `'public'`. Tightening them breaks OAuth
 * (external-provider redirect) or pre-login health probes.
 */
const MUST_BE_PUBLIC: ReadonlyArray<[string, string]> = [
  ['GET', '/oauth/start'],
  ['GET', '/oauth/callback'],
  ['GET', '/desktop/version'],
  ['OPTIONS', '/desktop/version'],
  ['GET', '/desktop/preflight'],
  ['OPTIONS', '/desktop/preflight'],
  // The desktop dev-wrapper bar's status poll (desktop-build-switcher-
  // wrapper-2026-06-09 P-010) — a native Rust HTTP client with no auth
  // context; tightening it blanks the bar's pipeline readout.
  ['GET', '/desktop/git-pipeline'],
  ['OPTIONS', '/desktop/git-pipeline'],
];

describe('D3 auth posture', () => {
  for (const rule of RULES) {
    it(`every route under ${rule.prefix} has the expected tier`, () => {
      const inFamily = ALL_ROUTES.filter((r) => r.path.startsWith(rule.prefix));
      expect(inFamily.length, `no routes found under ${rule.prefix}`).toBeGreaterThan(0);
      const wrong: string[] = [];
      for (const r of inFamily) {
        const exc = rule.exceptions?.find((e) => e.method === r.method && e.path === r.path);
        const expected = exc ? exc.auth : rule.expect;
        const actual = r.auth as unknown as RouteAuth;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          wrong.push(`  [${r.method}] ${r.path}  expected ${describeAuth(expected)}, got ${describeAuth(actual)}`);
        }
      }
      expect(wrong, `auth-tier drift under ${rule.prefix}:\n${wrong.join('\n')}`).toEqual([]);
    });
  }

  it.each(MUST_BE_PUBLIC)('%s %s must remain public', (method, path) => {
    const def = ALL_ROUTES.find((r) => r.method === method && r.path === path);
    expect(def, `${method} ${path} not registered`).toBeDefined();
    expect(def!.auth).toBe('public');
  });

  it('oauth/verify-paste is gated (browser-posted by a logged-in user)', () => {
    const def = ALL_ROUTES.find((r) => r.method === 'POST' && r.path === '/oauth/verify-paste');
    expect(def).toBeDefined();
    expect(def!.auth).toEqual(VT);
  });
});

describe('EI-100 security-posture recurrence guards', () => {
  it('keeps the bulk-resolve VTL route CSRF-gated before its flag gate or mutations', () => {
    const handlerStart = attentionBulkResolveSrc.indexOf('async function handler(');
    const handlerEnd = attentionBulkResolveSrc.indexOf('\nconst route = defineTool(', handlerStart);
    const handler = attentionBulkResolveSrc.slice(handlerStart, handlerEnd);
    const csrf = handler.indexOf('requireAllowedOriginOr403(req)');
    const flagGate = handler.indexOf('gateApiRoute(req, FLAGS.INBOX_BULK_RESOLVE)');
    const firstMutation = handler.indexOf('createRun({');

    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(csrf).toBeGreaterThan(-1);
    expect(flagGate).toBeGreaterThan(csrf);
    expect(firstMutation).toBeGreaterThan(flagGate);
  });

  it('keeps the retired GET /fleet/bee-output route out of ALL_ROUTES', () => {
    expect(ALL_ROUTES.find((route) => route.method === 'GET' && route.path === '/fleet/bee-output')).toBeUndefined();
  });
});

/**
 * Auth-tier Wave 1 (audit D-007/D-009, owner-approved 2026-06-10; landed
 * 2026-06-11 on WI-99): mutating routes are loopback-or-better, enforced at
 * the route-stack chokepoint. This registry gate is the standing P-038-style
 * lint — a NEW mutating route shipped as `auth: 'public'` fails here unless
 * the owner has confirmed it as a named remote exception (the OWNER rows of
 * apps/operator/docs/auth-tier-rollout-2026-06-10.md).
 */
describe('auth-tier Wave 1 — no public mutating routes (standing gate)', () => {
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  /** The owner-confirmed `public!` mutating exceptions (review 2026-06-11). */
  const OWNER_PUBLIC: ReadonlySet<string> = new Set([
    // change-password + auth/me PATCH were flipped public → 'loopback'
    // (2026-06-11, settings audit): they take the cookie-less-webview
    // default-user fallback (EI-338), so they must NOT also be remote-public.
    // Loopback admits the local webview while blocking off-box; a cross-origin
    // CSRF guard (requireAllowedOriginOr403) blocks foreign browser pages.
    'POST /auth/login',
    'POST /auth/logout',
    // Signup is additionally gated in-handler: first-account bootstrap, then
    // the OPEN_SIGNUP flag (default OFF).
    'POST /auth/signup',
    'DELETE /device/desktop/devices/:deviceId',
    'POST /device/desktop/mint-pair-token',
    'POST /device/pair',
    'POST /elevenlabs/webhook',
    'POST /flags/webhook',
  ]);
  /**
   * Own-auth routes — `auth: 'public'` at the route layer is intentional:
   * each route authenticates its caller in its handler or dispatch. Remote
   * reachability is part of the contract (for example, mobile built-in tools
   * and MCP transport calls across the tunnel). These are NOT owner-ratified
   * `public!` exceptions; keep them separate and require the same explicit
   * own-auth story before adding an entry.
   */
  const OWN_AUTH_ROUTES: ReadonlySet<string> = new Set([
    // Documenso e-signature completion (routes/pot/contracts.ts). The self-hosted
    // provider POSTs here remotely, so loopback would break signing. The handler
    // constant-time compares X-Documenso-Secret with DOCUMENSO_WEBHOOK_SECRET and
    // refuses invalid_webhook (a secret under 24 chars is not_configured). The
    // event body only identifies a candidate contract: completion re-reads the
    // envelope with the API key, matches both signers, and downloads the sealed
    // PDF and certificate itself (documenso.ts).
    'POST /dao-hr/documenso/webhook',
    'POST /agent-tools/*',
    'PUT /agent-tools/*',
    'PATCH /agent-tools/*',
    'DELETE /agent-tools/*',
    'POST /plugins/*',
    'PUT /plugins/*',
    'PATCH /plugins/*',
    'DELETE /plugins/*',
    'POST /:transport',
    'DELETE /:transport',
    // Cross-swarm authority RPC: remote peers POST lease/lock ops here via
    // HttpPeerRpcTransport — loopback would break federated authority.
    // verifyIsAuthority is the app-level check; EI-284 tracks the missing
    // caller-standing hardening.
    'POST /authority/rpc',
    // Connected-app device sign-in (RFC 8628; plan
    // external-app-access-to-workspaces-2026-09-29 P-005, D-018). The outside
    // app calls these from wherever it runs, so loopback would break the flow.
    // device/code needs no credential by design: it only opens a PENDING request
    // that the person at this computer must approve on the loopback-only
    // /connected-apps/device page. device/token authenticates with the secret
    // device_code and issues a key only for a request that was approved.
    'POST /connected-apps/device/code',
    'POST /connected-apps/device/token',
    // MCP OAuth (P-006). An MCP client registers (RFC 7591) and redeems its code from
    // wherever it runs, through the user's tunnel. register grants nothing: a client id
    // only lets the app ASK. token authenticates with a one-time code that exists only
    // after the owner consented, bound to the client, redirect URI and PKCE verifier.
    'POST /connected-apps/oauth/register',
    'POST /connected-apps/oauth/token',
    // Signed webhook ingress (P-017, D-032). An outside provider POSTs here through
    // the user's tunnel or the portal relay, so loopback would break it. The handler
    // authenticates every delivery itself: it refuses 401 unless papercusp-signature
    // carries a fresh HMAC-SHA256 of the body under the source's signing key, and
    // 403 while the Remote access switch is off (handleWebhookDelivery, webhook.ts).
    'POST /hooks/:sourceId',
    // Human-work market (routes/harness/work-items.ts postHumanWork). A person outside this
    // machine claims, submits, and gets graded/paid on an offered task over cors:true, so
    // loopback would break it. The handler authenticates every call itself: a mandatory human
    // session cookie (getSessionUser, else 401 human_session_required), a workspace match
    // (403 human_workspace_required), and an origin + JSON content-type check (403
    // human_request_origin_required). Neither a loopback caller nor an agent bearer is a human.
    'POST /harness/:slug/work-items/:id/human-work',
  ]);

  it('every mutating HTTP route declares a non-public tier unless owner-allowlisted', () => {
    const offenders = ALL_ROUTES.filter((r) => MUTATING.has(r.method))
      .filter((r) => (r.auth as unknown) === 'public')
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !OWNER_PUBLIC.has(key) && !OWN_AUTH_ROUTES.has(key));
    expect(
      offenders,
      `PUBLIC mutating route(s) — declare auth: 'loopback' (the Wave-1 rule) or get ` +
        `explicit owner sign-off and add the route to OWNER_PUBLIC here AND to the ` +
        `REMOTE_SURFACES list in scripts/gen-auth-tier-audit.mjs:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the owner allowlist is not stale (every entry still exists and is still public)', () => {
    for (const key of OWNER_PUBLIC) {
      const [method, path] = key.split(' ');
      const def = ALL_ROUTES.find((r) => r.method === method && r.path === path);
      expect(def, `${key} is allowlisted but no longer registered`).toBeDefined();
      expect(def!.auth, `${key} is allowlisted but no longer public — remove it`).toBe('public');
    }
  });

  it('loopback-tier coverage is substantial (the Wave-1 flip actually landed)', () => {
    const loopback = ALL_ROUTES.filter((r) => (r.auth as unknown) === 'loopback');
    expect(loopback.length).toBeGreaterThan(200);
  });
});

/**
 * WI-1388 (security): the harness SSE stream endpoints (routes/harness/streams.ts)
 * read harness run logs / an agent run's "thinking" timeline — tool inputs/RESULTS
 * that can hold file contents + secrets — by raw caller-supplied slug/runId with NO
 * workspace or ownership scoping. Every consumer is the loopback desktop webview via
 * a relative /api URL; the mobile path uses its OWN device-JWT endpoint
 * (/device/harnesses/:slug/log/stream, which re-implements the tail — not a proxy to
 * these). So gate them loopback-only: a network-exposed bind (PAPERCUSP_BIND_HOST=
 * 0.0.0.0) or a cloud-deployed frame can no longer serve these unauthenticated
 * (non-loopback → 403; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out).
 * This pins the tier so none drifts back to 'public'; the /adv/session/thinking sibling
 * was hardened first (the same file's prior pass).
 */
describe('harness SSE stream endpoints are loopback-gated (WI-1388)', () => {
  const STREAMS: ReadonlyArray<[string, string]> = [
    ['GET', '/harness/:slug/agents/:runId/stream'],
    ['GET', '/harness/:slug/stream'],
    ['GET', '/harness/:slug/log/stream'],
    ['GET', '/adv/session/thinking'],
  ];
  it.each(STREAMS)('%s %s is auth: loopback (never public)', (method, path) => {
    const def = ALL_ROUTES.find((r) => r.method === method && r.path === path);
    expect(def, `${method} ${path} not registered`).toBeDefined();
    expect(def!.auth).toBe('loopback');
  });
});

/**
 * WI-2144500 (security): harness configuration reads expose local files,
 * environment values, and execution policy. The matching PUT routes were
 * already loopback-gated; keep every sensitive GET on that same perimeter so
 * a network-exposed operator cannot serve those contents to an off-box caller.
 */
describe('sensitive harness configuration reads are loopback-gated (WI-2144500)', () => {
  const SENSITIVE_READS: ReadonlyArray<[string, string]> = [
    ['GET', '/harness/:slug/file'],
    ['GET', '/harness/:slug/mcp'],
    ['GET', '/harness/:slug/claude-settings'],
    ['GET', '/harness/:slug/claude-settings/effective'],
    ['GET', '/harness/:slug/env'],
  ];

  it.each(SENSITIVE_READS)('%s %s is auth: loopback (never public)', (method, path) => {
    const def = ALL_ROUTES.find((route) => route.method === method && route.path === path);
    expect(def, `${method} ${path} not registered`).toBeDefined();
    expect(def!.auth).toBe('loopback');
  });
});

/**
 * P-002: PTY output and exported session artifacts are private terminal
 * content, not public metadata. The control POSTs were already loopback-tier;
 * keep the read/list surfaces on that same perimeter so an off-box caller
 * cannot replay terminal output, enumerate transcripts, or learn the local
 * extension path.
 */
describe('PTY/session artifact reads are loopback-gated (P-002)', () => {
  const PRIVATE_PTY_READS: ReadonlyArray<[string, string]> = [
    ['GET', '/harness/:slug/pty/:id/stream'],
    ['GET', '/harness/:slug/pi-sessions/audit'],
    ['GET', '/harness/:slug/pi-sessions/audit/:filename'],
    ['GET', '/harness/:slug/pty/tools'],
  ];

  it.each(PRIVATE_PTY_READS)('%s %s is auth: loopback (never public)', (method, path) => {
    const def = ALL_ROUTES.find((route) => route.method === method && route.path === path);
    expect(def, `${method} ${path} not registered`).toBeDefined();
    expect(def!.auth).toBe('loopback');
  });
});

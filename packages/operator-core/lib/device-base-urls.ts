/**
 * Advertised device base-URLs — every route a paired phone can use to reach
 * this desktop, in preference order (on-desktop-direct-lan-voice-2026-07-14
 * P-005):
 *
 *   1. `mesh`   — Defguard WireGuard overlay address. Encrypted point-to-point;
 *                 only reachable once the phone has enrolled via the pair
 *                 response's `defguardEnrollmentUrl`. Preferred whenever it
 *                 answers.
 *   2. `lan`    — the desktop's RFC1918 address. ⚠ bare HTTP: the device JWT
 *                 and voice audio are sniffable on the local segment — a
 *                 conscious home-network tradeoff (plan D-008); mesh is
 *                 preferred when enrolled, and off-network traffic should use
 *                 the tunnel.
 *   3. `tunnel` — the Cloudflare tunnel (`MOBILE_DESKTOP_PUBLIC_URL`). TLS,
 *                 reachable from anywhere, but adds an edge round-trip.
 *
 * The phone probes in this order and uses the first reachable URL (P-006),
 * re-probing on network change. The list is advertised additively on the
 * pair response, `/device/runtime-config`, and the desktop-local
 * `/device/voice-session-init` response — old clients that only read
 * `server` / `desktopHost` / `meshHost` are unaffected.
 */
import { networkInterfaces } from 'node:os';

export interface AdvertisedBaseUrl {
  kind: 'mesh' | 'lan' | 'tunnel' | 'relay';
  url: string;
}

type IfaceMap = ReturnType<typeof networkInterfaces>;
type EnvMap = Record<string, string | undefined>;

/**
 * The portal device relay base URL when THIS operator is an enrolled hosted
 * workspace (android-public-release D-013 #1/#3, D-017): `<portal>/api/workspaces/<id>`.
 * The phone's client appends `/api/device/<route>`, which the portal relays to this
 * machine. Null on a desktop/local install. The portal origin is the hosted control
 * plane's own origin (`PAPERCUSP_HOSTED_CONTROL_PLANE_URL`, the same env the connector
 * dials); a ws(s) or socket-path form is normalised to its https origin.
 */
export function hostedDeviceRelayBaseUrl(workspaceId: string | null | undefined, env: EnvMap = process.env): string | null {
  const id = workspaceId?.trim();
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return null;
  if (!env.PAPERCUSP_HOSTED_CONNECTOR_BEARER?.trim()) return null;
  const base = env.PAPERCUSP_HOSTED_CONTROL_PLANE_URL?.trim();
  if (!base) return null;
  let origin: string;
  try {
    const parsed = new URL(base);
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    origin = `${secure ? 'https' : 'http'}://${parsed.host}`;
  } catch {
    return null;
  }
  return `${origin}/api/workspaces/${id}`;
}

/**
 * WireGuard/mesh interface names. `papercusp` is the Defguard network's
 * interface name on enrolled hosts; `wg*` / `defguard*` cover stock naming.
 */
const MESH_IFACE_RE = /^(papercusp|wg\d*|defguard)/i;

const RFC1918_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * First non-internal RFC1918 IPv4 on this host — so pairing/discovery
 * advertises a LAN address the phone can route to (vs `localhost`, which on
 * the phone resolves to the phone itself). Mesh-named interfaces are skipped:
 * their overlay IPs are RFC1918 too, but they are only reachable by enrolled
 * peers and are advertised separately as `mesh`.
 */
export function lanAddressFrom(ifaces: IfaceMap): string | null {
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || MESH_IFACE_RE.test(name)) continue;
    for (const i of list) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (RFC1918_RE.test(i.address)) return i.address;
    }
  }
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || MESH_IFACE_RE.test(name)) continue;
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

export function lanAddress(): string | null {
  return lanAddressFrom(networkInterfaces());
}

/** First IPv4 on a mesh-named (WireGuard/Defguard) interface, if enrolled. */
export function meshAddressFrom(ifaces: IfaceMap): string | null {
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || !MESH_IFACE_RE.test(name)) continue;
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

export function meshAddress(): string | null {
  return meshAddressFrom(networkInterfaces());
}

/** `host`, `host:port`, or a full URL → a normalized `http(s)://host:port`. */
function normalizeHost(raw: string, defaultPort: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return /:\d+$/.test(trimmed)
    ? `http://${trimmed}`
    : `http://${trimmed}:${defaultPort}`;
}

/**
 * The ordered advertise list. `port` is the operator's OWN bound port for the
 * mesh/LAN entries — pass one derived from a paired host when available; the
 * runtime-assigned `PORT` env (Tauri sidecar/bin/prod/bin/dev all set it) is
 * the fallback. The request Host's port is NOT a safe source: a phone coming
 * in via the tunnel sends the tunnel's host, not the local bind.
 */
export function advertisedBaseUrls(opts?: {
  port?: string | number | null;
  ifaces?: IfaceMap;
  env?: EnvMap;
  /** The paired workspace; on a hosted machine it selects the portal relay URL. */
  workspaceId?: string | null;
}): AdvertisedBaseUrl[] {
  const env = opts?.env ?? process.env;
  // A hosted machine's mesh/LAN addresses are VM-private and unreachable from a
  // phone, so the portal relay is its ONLY route (D-013 #3).
  const relay = hostedDeviceRelayBaseUrl(opts?.workspaceId, env);
  if (relay) return [{ kind: 'relay', url: relay }];
  const ifaces = opts?.ifaces ?? networkInterfaces();
  const port = String(opts?.port ?? env.PORT ?? '3055');

  const urls: AdvertisedBaseUrl[] = [];

  const meshHostEnv = env.MOBILE_MESH_HOST?.trim();
  if (meshHostEnv) {
    urls.push({ kind: 'mesh', url: normalizeHost(meshHostEnv, port) });
  } else {
    const mesh = meshAddressFrom(ifaces);
    if (mesh) urls.push({ kind: 'mesh', url: `http://${mesh}:${port}` });
  }

  const lan = lanAddressFrom(ifaces);
  if (lan) urls.push({ kind: 'lan', url: `http://${lan}:${port}` });

  const publicUrl = env.MOBILE_DESKTOP_PUBLIC_URL?.trim();
  if (publicUrl) {
    urls.push({ kind: 'tunnel', url: publicUrl.replace(/\/$/, '') });
  }

  return urls;
}

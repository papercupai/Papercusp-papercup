import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOX_LOCAL_TABLE, TUNNEL, TURN_RELAY_RANGE, boxLocalDnat, boxWireguard, edgeCoordinates, forwardedPorts, livekitInterfaces,
  nginxSite, nginxStream, vmNftables, vmWireguard,
} from "../../../../infra/phone-app/edge/edge-config.mjs";
import { NON_PUBLIC_V4_SUBNETS, isPublicAddress } from "../../../../infra/phone-app/media-config.mjs";

// Plan phone-public-telephone-service-2026-10-01, P-002, D-024/D-025: the public media edge.
const repoRoot = resolve(import.meta.dirname, "../../../..");
const edgeScript = resolve(repoRoot, "infra/phone-app/edge/edge.sh");
const template = resolve(repoRoot, "infra/phone-app/livekit-server.yaml.tmpl");
const deployScript = resolve(repoRoot, "infra/phone-app/deploy.sh");

const env = {
  PHONE_EDGE_PUBLIC_IP: "34.23.13.209",
  PHONE_EDGE_VOICE_HOST: "phone-voice.papercusp.com",
  PHONE_EDGE_TURN_HOST: "phone-turn.papercusp.com",
};
const KEY_A = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const KEY_B = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";

describe("phone public media edge coordinates", () => {
  it("accepts a global IPv4 address with two distinct public hostnames", () => {
    expect(edgeCoordinates(env)).toEqual({
      publicIp: "34.23.13.209", voiceHost: "phone-voice.papercusp.com", turnHost: "phone-turn.papercusp.com",
      boxIface: "phedge0", wanIface: "ens4", turnPort: 7894, sip: false,
    });
  });

  it.each(["10.0.0.1", "192.168.4.34", "127.0.0.1", "100.74.143.93", "2001:db8::1", "", "not-an-ip"])(
    "rejects a non-global edge address %j",
    (address) => {
      expect(() => edgeCoordinates({ ...env, PHONE_EDGE_PUBLIC_IP: address })).toThrow(/global IPv4/);
    },
  );

  it("refuses a shared WSS/TURN hostname, a hostile interface name and a colliding TURN port", () => {
    expect(() => edgeCoordinates({ ...env, PHONE_EDGE_TURN_HOST: env.PHONE_EDGE_VOICE_HOST })).toThrow(/separate/);
    expect(() => edgeCoordinates({ ...env, PHONE_EDGE_IFACE: "wg0; rm -rf /" })).toThrow(/interface/);
    expect(() => edgeCoordinates({ ...env, PHONE_TURN_TLS_PORT: "7892" })).toThrow(/TURN TLS backend port/);
    expect(() => edgeCoordinates({ ...env, PHONE_EDGE_VOICE_HOST: "voice.internal" })).toThrow();
  });
});

describe("phone public media edge tunnel", () => {
  const c = edgeCoordinates(env);

  it("never makes the edge's public IP a box-local address (the WireGuard endpoint would loop back)", () => {
    const box = boxWireguard(c, KEY_A);
    const address = box.split("\n").find((line) => line.startsWith("Address"));
    expect(address).toBe(`Address = ${TUNNEL.box}/${TUNNEL.prefix}`);
    expect(box).toContain(`Endpoint = ${c.publicIp}:${TUNNEL.port}`);
  });

  it("routes only traffic sourced from the tunnel address through the edge, not the box's default route", () => {
    const box = boxWireguard(c, KEY_A);
    expect(box).toContain("Table = off");
    expect(box).toContain(`ip rule add from ${TUNNEL.box} lookup ${TUNNEL.table}`);
    expect(box).toContain(`ip route replace default dev %i table ${TUNNEL.table}`);
    expect(box).toContain("AllowedIPs = 0.0.0.0/0");
  });

  it("loads WireGuard private keys by path and rejects anything that is not a public key", () => {
    for (const conf of [boxWireguard(c, KEY_A), vmWireguard(c, KEY_B)]) {
      expect(conf).not.toMatch(/PrivateKey\s*=/);
      expect(conf).toMatch(/private-key \/etc\/wireguard\/[a-z0-9-]+\.key/);
    }
    expect(vmWireguard(c, KEY_B)).toContain(`AllowedIPs = ${TUNNEL.box}/32`);
    expect(() => vmWireguard(c, "not a key")).toThrow(/public key/);
    expect(() => boxWireguard(c, `${KEY_A}\nPostUp = curl evil`)).toThrow(/public key/);
  });

  // WI-10006708: with the edge, LiveKit advertises only the public candidate, so co-located
  // services (agent worker, livekit-sip) reach it through a box-local DNAT. It must touch only
  // locally ORIGINATED media to the public IP: never inbound, never the WireGuard endpoint.
  it("DNATs only locally originated media to the public IP back to the tunnel address", () => {
    const box = boxWireguard(c, KEY_A);
    const script = boxLocalDnat(c);
    expect(box.split("\n").filter((l) => l.startsWith("PostUp = nft "))).toEqual([`PostUp = nft '${script}'`]);
    expect(box).toContain(`PreDown = nft delete table ip ${BOX_LOCAL_TABLE} 2>/dev/null || true`);
    expect(script).toContain("type nat hook output priority dstnat;");
    expect(script).not.toMatch(/hook (prerouting|input|forward|postrouting)/);
    const dnats = script.match(/dnat to [0-9.]+/g) ?? [];
    expect(dnats).toEqual(forwardedPorts().map(() => `dnat to ${TUNNEL.box}`));
    for (const p of forwardedPorts()) {
      expect(script).toContain(`ip daddr ${c.publicIp} ${p.proto} dport ${p.ports} dnat to ${TUNNEL.box}`);
    }
    expect(script).not.toContain(`dport ${TUNNEL.port}`);
    expect(script).not.toContain("5070");
    // Wrapped in single quotes by wg-quick's bash eval: a quote inside would split it.
    expect(script).not.toContain("'");
    // Idempotent: re-running PostUp replaces the table instead of duplicating rules.
    expect(script.startsWith(`add table ip ${BOX_LOCAL_TABLE}; delete table ip ${BOX_LOCAL_TABLE}; `)).toBe(true);
    // nft's one-line grammar rejects a block closed straight into its parent's `}` ("syntax
    // error, unexpected '}', expecting newline or semicolon" — measured with `nft -c` on
    // nftables 1.0.9). Every nested block must be terminated with `;` first.
    expect(script).not.toMatch(/\}\s*\}/);
    expect(script.endsWith("; }; }")).toBe(true);
  });

  // WI-10006708, measured live: with the relay's own flows DNATed locally, the SFU saw the
  // relay's LAN source and echoed it to the browser (selected local candidate became
  // prflx 192.168.4.34 instead of relay). The relay port range must return BEFORE any DNAT.
  it("exempts the TURN relay's source ports from the box-local DNAT, before any DNAT rule", () => {
    const rules = boxLocalDnat(edgeCoordinates(env)).split("; ");
    const exempt = rules.indexOf(`udp sport ${TURN_RELAY_RANGE.start}-${TURN_RELAY_RANGE.end} return`);
    const firstDnat = rules.findIndex((r) => r.includes("dnat to"));
    expect(exempt).toBeGreaterThan(-1);
    expect(exempt).toBeLessThan(firstDnat);
    const tmpl = readFileSync(template, "utf8");
    expect(tmpl).toMatch(new RegExp(`^  relay_range_start: ${TURN_RELAY_RANGE.start}$`, "m"));
    expect(tmpl).toMatch(new RegExp(`^  relay_range_end: ${TURN_RELAY_RANGE.end}$`, "m"));
  });
});

describe("phone public media edge forwarding", () => {
  const c = edgeCoordinates(env);

  it("DNATs media ports to the box without masquerading inbound, so clients keep their real addresses", () => {
    const rules = vmNftables(c);
    for (const { proto, ports } of forwardedPorts()) {
      expect(rules).toContain(`iifname "ens4" ${proto} dport ${ports} dnat to ${TUNNEL.box}`);
    }
    const masquerades = rules.split("\n").filter((line) => line.includes("masquerade"));
    expect(masquerades).toEqual([`    oifname "ens4" ip saddr ${TUNNEL.box} masquerade`]);
    expect(rules).toContain("type filter hook forward priority filter; policy drop;");
  });

  it("keeps SIP and RTP closed until they are explicitly enabled for the carrier", () => {
    expect(vmNftables(c)).not.toMatch(/dport (5070|40000-40200)/);
    const withSip = vmNftables(edgeCoordinates({ ...env, PHONE_EDGE_FORWARD_SIP: "1" }));
    expect(withSip).toContain(`udp dport 40000-40200 dnat to ${TUNNEL.box}`);
    expect(withSip).toContain(`tcp dport 5070 dnat to ${TUNNEL.box}`);
  });

  // WI-10006686: LiveKit followed a test browser's PRIVATE host candidate (10.138.0.3) out
  // through the edge into the GCP VPC. Callers choose ICE candidates, so box egress must
  // never reach a non-public destination, and the drop must come before the egress accept.
  it("never forwards box traffic into private, VPC or special ranges", () => {
    const forward = vmNftables(c).split("\n");
    const dropAt = forward.findIndex((l) => l.includes(`iifname "wg-phone" ip daddr {`) && l.includes(" drop"));
    const acceptAt = forward.findIndex((l) => l.includes(`ip saddr ${TUNNEL.box} accept`));
    expect(dropAt).toBeGreaterThan(-1);
    expect(dropAt).toBeLessThan(acceptAt);
    const cidrs = forward[dropAt].match(/\{([^}]*)\}/)![1].split(",").map((s) => s.trim());
    const toInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
    const covered = (ip: string) => cidrs.some((cidr) => {
      const [net, bits] = cidr.split("/");
      const size = 2 ** (32 - Number(bits));
      return Math.floor(toInt(ip) / size) === Math.floor(toInt(net) / size);
    });
    const nonPublic = ["10.138.0.3", "10.142.0.3", "10.128.0.14", "192.168.4.34", "172.27.0.1",
      "100.64.1.1", "169.254.169.254", "127.0.0.1", "0.0.0.1", "224.0.0.251", "198.18.0.1",
      "192.0.0.8", "192.0.2.5", "203.0.113.9", "240.0.0.1"];
    const publicAddrs = ["34.168.26.215", "34.23.13.209", "104.148.223.66", "8.8.8.8", "1.1.1.1"];
    for (const ip of nonPublic) {
      expect(isPublicAddress(ip), ip).toBe(false);
      expect(covered(ip), ip).toBe(true);
    }
    for (const ip of publicAddrs) {
      expect(isPublicAddress(ip), ip).toBe(true);
      expect(covered(ip), ip).toBe(false);
    }
    // Every range the shared public-address check rejects is in the drop set.
    expect(cidrs).toEqual(NON_PUBLIC_V4_SUBNETS.map(([ip, prefix]) => `${ip}/${prefix}`));
  });
});

describe("phone public media edge TLS front end", () => {
  const c = edgeCoordinates(env);

  it("routes only the configured admission path and restricts its backend to the edge peer", () => {
    const configured = edgeCoordinates({ ...env, PHONE_PRODUCER_LISTEN_PORT: "7905" });
    const site = nginxSite(configured, { withTls: true });
    expect(site).toContain("location = /platform/producer-admission {");
    expect(site).toContain(`proxy_pass http://${TUNNEL.box}:7905;`);
    expect(site).toContain("proxy_set_header Authorization $http_authorization;");
    expect(nginxSite(c, { withTls: true })).not.toContain("/platform/producer-admission");
    expect(nginxSite(configured, { withTls: false })).not.toContain("/platform/producer-admission");
    const box = boxWireguard(configured, KEY_A);
    expect(box).toContain(`ip daddr ${TUNNEL.box} tcp dport 7905 iifname "phedge0" ip saddr ${TUNNEL.edge} accept; tcp dport 7905 drop;`);
    expect(box).toContain("PreDown = nft delete table inet phone_admission");
    expect(boxWireguard(c, KEY_A)).not.toContain("phone_admission");
  });

  it.each(["", "0", "7890", "7894", "51820", "65536", "7905;evil", "1.5"])("rejects invalid admission port %j", (port) => {
    expect(() => edgeCoordinates({ ...env, PHONE_PRODUCER_LISTEN_PORT: port })).toThrow(/admission backend port/);
  });

  it("passes TURN/TLS through to LiveKit by SNI and terminates WSS locally", () => {
    const stream = nginxStream(c);
    expect(stream).toContain("ssl_preread on;");
    expect(stream).toContain(`phone-turn.papercusp.com ${TUNNEL.box}:7894;`);
    expect(stream).toContain("default 127.0.0.1:8443;");
    expect(stream).toContain("listen 443;");
  });

  it("serves only ACME and redirects before the WSS certificate exists", () => {
    const bootstrap = nginxSite(c, { withTls: false });
    expect(bootstrap).toContain("location /.well-known/acme-challenge/ { root /var/www/phone-edge-acme; }");
    expect(bootstrap).not.toContain("ssl_certificate");
  });

  it("proxies the WSS host to LiveKit's internal port with WebSocket upgrade once certified", () => {
    const site = nginxSite(c, { withTls: true });
    expect(site).toContain("ssl_certificate /etc/letsencrypt/live/phone-voice.papercusp.com/fullchain.pem;");
    expect(site).toContain(`proxy_pass http://${TUNNEL.box}:7890;`);
    expect(site).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(site).toContain("listen 127.0.0.1:8443 ssl;");
  });
});

describe("LiveKit advertises only public media candidates once the edge is configured", () => {
  function renderIncludes(envOverride: Record<string, string>) {
    const rendered = readFileSync(template, "utf8")
      .replace("${PHONE_LIVEKIT_INTERFACES}", livekitInterfaces(envOverride));
    const lines = rendered.split("\n");
    const start = lines.indexOf("    includes:");
    expect(start).toBeGreaterThan(0);
    const items: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("      ")) break;
      if (line.trimStart().startsWith("- ")) items.push(line.trim().slice(2));
    }
    return items;
  }

  // WI-10006708 / P-002 R-13: LiveKit hands the same candidates to every participant, so a
  // LAN or loopback interface listed here is handed to every public browser (measured live:
  // 192.168.4.34 udp/7892 + tcp/7891 reached public callers while the edge was configured).
  it("lists only the tunnel with an edge, and loopback + LAN without one", () => {
    expect(renderIncludes({ PHONE_EDGE_IFACE: "phedge0", PHONE_LAN_IFACE: "wlp183s0" })).toEqual(["phedge0"]);
    expect(renderIncludes({ PHONE_LAN_IFACE: "wlp183s0" })).toEqual(["lo", "wlp183s0"]);
    expect(() => livekitInterfaces({ PHONE_EDGE_IFACE: "x\n  use_external_ip: false" })).toThrow();
    expect(() => livekitInterfaces({ PHONE_LAN_IFACE: "wlp183s0\n      - lo" })).toThrow();
    expect(() => livekitInterfaces({})).toThrow(/PHONE_LAN_IFACE/);
  });

  it("is rendered and persisted by the existing deployer, with no second interface placeholder", () => {
    const deploy = readFileSync(deployScript, "utf8");
    expect(deploy).toMatch(/MEDIA_KEYS=\([^)]*PHONE_EDGE_IFACE[^)]*\)/);
    expect(deploy).toContain("content=\"${content//'${PHONE_LIVEKIT_INTERFACES}'/$PHONE_LIVEKIT_INTERFACES}\"");
    expect(deploy).toContain("PHONE_LAN_IFACE=\"$LAN_IFACE\" \"$NODE_BIN\" \"$HERE/edge/edge-config.mjs\" livekit-interfaces");
    const tmpl = readFileSync(template, "utf8");
    expect(tmpl.match(/\$\{PHONE_[A-Z_]*IFACE[A-Z_]*\}/g)).toBeNull();
    expect(tmpl.match(/\$\{PHONE_LIVEKIT_INTERFACES\}/g)).toHaveLength(1);
  });

  it("keeps the edge driver syntactically valid", () => {
    const result = spawnSync("bash", ["-n", edgeScript], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([undefined, "7895"])("round-trips the optional admission port %j through edge.env into the renderer", (port) => {
    const dir = mkdtempSync(join(tmpdir(), "phone-edge-env-"));
    try {
      const source = readFileSync(edgeScript, "utf8").split('case "${1:-}" in')[0];
      // Annotated: spreading the concrete `env` after process.env drops the
      // index signature, which would make this delete a TS2339.
      const testEnv: NodeJS.ProcessEnv = { ...process.env, ...env, PHONE_CONFIG_DIR: dir };
      delete testEnv.PHONE_PRODUCER_LISTEN_PORT;
      writeFileSync(join(dir, "edge.env"), port === undefined ? "" : `PHONE_PRODUCER_LISTEN_PORT=${port}\n`);
      const result = spawnSync("bash", ["-c", `${source}\nHERE="$EDGE_SOURCE_DIR"\npersist\nrender nginx-site`], {
        encoding: "utf8", env: { ...testEnv, EDGE_SOURCE_DIR: dirname(edgeScript) },
      });
      expect(result.status, result.stderr).toBe(0);
      const saved = readFileSync(join(dir, "edge.env"), "utf8");
      if (port === undefined) {
        expect(saved).not.toContain("PHONE_PRODUCER_LISTEN_PORT");
        expect(result.stdout).not.toContain("/platform/producer-admission");
      } else {
        expect(saved).toContain(`PHONE_PRODUCER_LISTEN_PORT=${port}\n`);
        expect(result.stdout).toContain(`10.77.0.2:${port}`);
        expect(result.stdout).toContain("/platform/producer-admission");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// WI-10006571: `deploy.sh --rotate-secret` used to truncate livekit.env to the two
// LiveKit lines, deleting the worker's DEEPGRAM_API_KEY (STT then resolved to a
// fallback vendor and the worker refused to start) and any TELNYX_API_KEY (D-020).
// PROBE_DEPLOY_SCRIPT lets scripts/mutation-probe.sh point these at a mutated copy.
const probedDeployScript = process.env.PROBE_DEPLOY_SCRIPT ?? deployScript;

/** The named top-level shell functions of deploy.sh, verbatim, so tests run the real code. */
function extractShellFunctions(script: string, names: string[]): string {
  const lines = readFileSync(script, "utf8").split("\n");
  const out: string[] = [];
  for (const name of names) {
    const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
    expect(start, `${name}() must be defined in deploy.sh`).toBeGreaterThanOrEqual(0);
    if (lines[start].trimEnd().endsWith("}")) { out.push(lines[start]); continue; }
    const end = lines.findIndex((line, i) => i > start && line === "}");
    expect(end).toBeGreaterThan(start);
    out.push(...lines.slice(start, end + 1));
  }
  return out.join("\n");
}

describe("rotating the LiveKit secret keeps the rest of livekit.env", () => {
  const script = probedDeployScript;
  const shellFunctions = () => extractShellFunctions(script, ["die", "upsert_env_var", "write_livekit_credentials"]);

  function rotate(existing: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "phone-env-"));
    const envFile = join(dir, "livekit.env");
    if (existing !== null) writeFileSync(envFile, existing, { mode: 0o600 });
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${shellFunctions()}\nwrite_livekit_credentials NEWKEY NEWSECRET`], {
      encoding: "utf8",
      env: { ...process.env, CONF_DIR: dir, ENV_FILE: envFile },
    });
    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(envFile, "utf8");
    const mode = statSync(envFile).mode & 0o777;
    rmSync(dir, { recursive: true, force: true });
    return { content, mode };
  }

  it("replaces only the key pair and preserves every other credential", () => {
    const { content, mode } = rotate([
      "PHONE_LIVEKIT_API_KEY=OLDKEY",
      "PHONE_LIVEKIT_API_SECRET=OLDSECRET",
      "DEEPGRAM_API_KEY=dg-test",
      "GOOGLE_CLOUD_PROJECT=proj-test",
      "TELNYX_API_KEY=KEYtest",
      "PHONE_EDGE_IFACE=phedge0",
      "",
    ].join("\n"));
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toEqual(expect.arrayContaining([
      "DEEPGRAM_API_KEY=dg-test",
      "GOOGLE_CLOUD_PROJECT=proj-test",
      "TELNYX_API_KEY=KEYtest",
      "PHONE_EDGE_IFACE=phedge0",
      "PHONE_LIVEKIT_API_KEY=NEWKEY",
      "PHONE_LIVEKIT_API_SECRET=NEWSECRET",
    ]));
    expect(lines).toHaveLength(6);
    expect(content).not.toContain("OLD");
    expect(mode).toBe(0o600);
  });

  it("creates a private file holding just the key pair on first run", () => {
    const { content, mode } = rotate(null);
    expect(content.split("\n").filter(Boolean).sort()).toEqual([
      "PHONE_LIVEKIT_API_KEY=NEWKEY",
      "PHONE_LIVEKIT_API_SECRET=NEWSECRET",
    ]);
    expect(mode).toBe(0o600);
  });

  it("is the only path the credentials step uses to write the key pair", () => {
    const deploy = readFileSync(script, "utf8");
    expect(deploy).toContain('write_livekit_credentials "$KEY" "$SECRET"');
    const truncating = deploy.split("\n").filter((line) => /[^>]>\s*"\$ENV_FILE"/.test(line));
    expect(truncating.every((line) => line.includes('[[ -f "$ENV_FILE" ]] ||'))).toBe(true);
  });

  it("keeps the deployer syntactically valid", () => {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});

// WI-10006587: deploy.sh armed the ops-alert timer but never wrote ops-alert.env
// or scheduled a backup, so every 15-minute run reported backup:config-missing.
describe("the deployer configures the Phone backup the ops-alert check verifies", () => {
  const script = probedDeployScript;
  const here = dirname(script);
  const shellFunctions = () => extractShellFunctions(script, ["die", "upsert_env_var", "write_ops_alert_env"]);

  function writeEnv(existing: string | null, archive: string, maxAge: string) {
    const dir = mkdtempSync(join(tmpdir(), "phone-ops-env-"));
    const opsEnv = join(dir, "ops-alert.env");
    if (existing !== null) writeFileSync(opsEnv, existing, { mode: 0o644 });
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${shellFunctions()}\nwrite_ops_alert_env "$A" "$M"`], {
      encoding: "utf8",
      env: { ...process.env, CONF_DIR: dir, ENV_FILE: join(dir, "livekit.env"), OPS_ALERT_ENV_FILE: opsEnv, A: archive, M: maxAge },
    });
    const content = existsSync(opsEnv) ? readFileSync(opsEnv, "utf8") : null;
    const mode = existsSync(opsEnv) ? statSync(opsEnv).mode & 0o777 : null;
    const livekitTouched = existsSync(join(dir, "livekit.env"));
    rmSync(dir, { recursive: true, force: true });
    return { result, content, mode, livekitTouched };
  }

  it("creates a private ops-alert.env with exactly the two backup settings", () => {
    const { result, content, mode, livekitTouched } = writeEnv(null, "/srv/phone/backups/phone-db.dump", "36");
    expect(result.status, result.stderr).toBe(0);
    expect(content!.split("\n").filter(Boolean).sort()).toEqual([
      "PHONE_BACKUP_ARCHIVE=/srv/phone/backups/phone-db.dump",
      "PHONE_BACKUP_MAX_AGE_HOURS=36",
    ]);
    expect(mode).toBe(0o600);
    expect(livekitTouched).toBe(false);
  });

  it("rewrites only the backup lines and keeps the owner's other settings", () => {
    const { result, content } = writeEnv(
      ["PHONE_BACKUP_ARCHIVE=/old.dump", "PHONE_ALERT_CHANNEL=owner", "PHONE_BACKUP_MAX_AGE_HOURS=999", ""].join("\n"),
      "/new/phone-db.dump",
      "24",
    );
    expect(result.status, result.stderr).toBe(0);
    const lines = content!.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(expect.arrayContaining([
      "PHONE_ALERT_CHANNEL=owner",
      "PHONE_BACKUP_ARCHIVE=/new/phone-db.dump",
      "PHONE_BACKUP_MAX_AGE_HOURS=24",
    ]));
  });

  it("refuses values the ops-alert check would reject as config-missing", () => {
    for (const [archive, maxAge] of [["relative/phone.dump", "36"], ["/a.dump", "0"], ["/a.dump", "169"], ["/a.dump", "1h"]]) {
      const { result, content } = writeEnv(null, archive, maxAge);
      expect(result.status, `${archive} ${maxAge}`).not.toBe(0);
      expect(content).toBeNull();
    }
  });

  it("installs a daily backup unit that writes the archive ops-alert.env names, before arming the alert", () => {
    const deploy = readFileSync(script, "utf8");
    const unit = readFileSync(join(here, "systemd/papercusp-phone-backup.service.tmpl"), "utf8");
    const timer = readFileSync(join(here, "systemd/papercusp-phone-backup.timer"), "utf8");
    expect(unit).toMatch(/^EnvironmentFile=\$\{PHONE_CONFIG_DIR\}\/ops-alert\.env$/m);
    // --replace: the daily timer refreshes ONE fixed archive path, so each run must overwrite
    // the previous dump (WI-10006587; phone-app-backup.integration.test.ts proves the overwrite).
    expect(unit).toMatch(/^ExecStart=\$\{PHONE_NODE_BIN\} \$\{PHONE_BACKUP_SCRIPT\} backup --out \$PHONE_BACKUP_ARCHIVE --replace$/m);
    expect(deploy).toContain("content=\"${content//'${PHONE_BACKUP_SCRIPT}'/$HERE/phone-db-backup.mjs}\"");
    expect(timer).toMatch(/^OnCalendar=daily$/m);
    expect(timer).toMatch(/^Unit=papercusp-phone-backup\.service$/m);
    expect(deploy).toContain('write_ops_alert_env "$PHONE_BACKUP_ARCHIVE" "$PHONE_BACKUP_MAX_AGE_HOURS"');
    const backupArmed = deploy.indexOf("systemctl --user enable --now papercusp-phone-backup.timer");
    const firstBackup = deploy.indexOf("systemctl --user start papercusp-phone-backup.service");
    const alertArmed = deploy.indexOf("systemctl --user enable --now papercusp-phone-ops-alert.timer");
    expect(backupArmed).toBeGreaterThan(0);
    expect(firstBackup).toBeGreaterThan(backupArmed);
    expect(alertArmed).toBeGreaterThan(firstBackup);
  });
});

// Both 2026-10-06 hosted redeploys exited 1 because one readiness read straight
// after the restart caught the sidecar's HTTP endpoint a few seconds early.
describe("the deployer waits for readiness to converge after a restart", () => {
  function awaitReadiness(readyOnCall: number | null, attempts: number) {
    const dir = mkdtempSync(join(tmpdir(), "phone-ready-"));
    const counter = join(dir, "calls");
    writeFileSync(counter, "0");
    const stub = [
      "report_status() {",
      `  local n=$(( $(cat '${counter}') + 1 )); echo "$n" > '${counter}'`,
      readyOnCall === null
        ? '  echo "NOT_READY $n"; return 1'
        : `  if (( n >= ${readyOnCall} )); then echo "READY $n"; else echo "NOT_READY $n"; return 1; fi`,
      "}",
    ].join("\n");
    const fn = extractShellFunctions(probedDeployScript, ["await_readiness"]);
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${stub}\n${fn}\nawait_readiness ${attempts}`], {
      encoding: "utf8",
      env: { ...process.env, PHONE_READINESS_RETRY_SEC: "0" },
    });
    const calls = Number(readFileSync(counter, "utf8").trim());
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status, stdout: result.stdout, calls };
  }

  it("succeeds once a transiently unready component converges, printing one report", () => {
    const { status, stdout, calls } = awaitReadiness(3, 30);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("READY 4");
    expect(calls).toBe(4);
  });

  it("still fails closed, within its bound, when a component never converges", () => {
    const { status, stdout, calls } = awaitReadiness(null, 5);
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe("NOT_READY 5");
    expect(calls).toBe(5);
  });

  it("is what the deployer runs as its final health step", () => {
    const deploy = readFileSync(probedDeployScript, "utf8");
    const finalStep = deploy.slice(deploy.lastIndexOf('step "Health"'));
    expect(finalStep).toMatch(/\nawait_readiness \d+\n/);
    expect(finalStep).not.toMatch(/\nreport_status\n/);
  });
});

// WI-10006603: the public TURN server must not relay to private or loopback peers.
// livekit-server gained that default in v1.12.0 and the per-participant relay cap
// in v1.13.6; the 1.10.1 build that was deployed relayed anywhere, livekit-sip included.
describe("the deployer refuses a livekit-server whose TURN relays to private peers", () => {
  const floor = () => /^LK_MIN_VERSION="([^"]+)"$/m.exec(readFileSync(probedDeployScript, "utf8"))?.[1];

  function requireVersion(reported: string) {
    const dir = mkdtempSync(join(tmpdir(), "phone-lkver-"));
    const bin = join(dir, "livekit-server");
    writeFileSync(bin, `#!/usr/bin/env bash\necho 'livekit-server version ${reported}'\n`, { mode: 0o755 });
    const fns = extractShellFunctions(probedDeployScript, ["say", "die", "require_livekit_version"]);
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${fns}\nrequire_livekit_version '${bin}' '${floor()}'`], {
      encoding: "utf8",
    });
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it("refuses the 1.10.1 build that was deployed, and every version below the floor", () => {
    for (const old of ["1.10.1", "1.12.0", "1.13.5", "0.99.99"]) {
      const { status, out } = requireVersion(old);
      expect(status, old).not.toBe(0);
      expect(out, old).toContain("WI-10006603");
    }
  });

  it("accepts the floor and newer, comparing versions numerically rather than as text", () => {
    for (const ok of ["1.13.6", "1.13.7", "1.13.10", "2.0.0"]) {
      const { status, out } = requireVersion(ok);
      expect(status, ok).toBe(0);
      expect(out).toContain(`livekit-server ${ok}`);
    }
  });

  it("refuses when the version cannot be read", () => {
    const { status, out } = requireVersion("dev");
    expect(status).not.toBe(0);
    expect(out).toContain("cannot read a livekit-server version");
  });

  it("is the preflight check, at a floor that has both TURN protections", () => {
    const [major, minor, patch] = (floor() ?? "0.0.0").split(".").map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1_013_006);
    expect(readFileSync(probedDeployScript, "utf8")).toMatch(/\nrequire_livekit_version "\$LK_BIN" "\$LK_MIN_VERSION"\n/);
  });
});

describe("the public TURN server keeps private and loopback peers unreachable", () => {
  const live = (file: string) =>
    readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

  it("never opts a restricted range back in, in the template or in what the deployer renders into it", () => {
    for (const file of [template, probedDeployScript]) {
      expect(live(file), file).not.toMatch(/allow_restricted_peer_cidrs/);
    }
  });

  it("caps relay allocations per participant", () => {
    const limit = /^\s+per_user_relay_allocation_limit:\s*(\d+)\s*$/m.exec(live(template))?.[1];
    expect(Number(limit)).toBeGreaterThan(0);
  });
});

describe("public clients are only offered TURN they can reach (WI-10006616)", () => {
  const live = (file: string) =>
    readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const turnBlock = () => /^turn:\n((?:[ \t]+.*\n|\n)*)/m.exec(live(template))?.[1] ?? "";

  it("keeps TURN TLS-only, so no turn:<home IP>:<udp port> URL is issued", () => {
    expect(turnBlock()).toMatch(/^\s+enabled:\s*true\s*$/m);
    expect(turnBlock()).not.toMatch(/udp_port/);
  });

  it("neither the edge nor its firewall forwards a TURN/UDP port", () => {
    expect(forwardedPorts().filter(({ proto, ports }) => proto === "udp" && ports !== "7892")).toEqual([]);
    expect(forwardedPorts({ sip: true }).some(({ ports }) => ports === "7893")).toBe(false);
    const edgeScript = live(resolve(repoRoot, "infra/phone-app/edge/edge.sh"));
    expect(edgeScript).not.toMatch(/udp:7893/);
    expect(edgeScript).not.toMatch(/ufw allow in on [^\n]*port [0-9,]*7893/);
  });
});

// WI-10006623: `edge.sh apply-box` runs the TURN certificate deploy hook on every run, and the
// hook restarted LiveKit even when the certificate was unchanged. Each idempotent re-run
// therefore dropped live calls, and the public WSS answered 502 for ~15s. The hook must
// hand over and restart only when the lineage actually differs from LiveKit's copy.
// PROBE_EDGE_SCRIPT lets scripts/mutation-probe.sh point this at a mutated copy.
describe("TURN certificate deploy hook restarts LiveKit only for a changed certificate (WI-10006623)", () => {
  it("installs and restarts on first hand-over and on a change, and is a no-op when unchanged", () => {
    const tmp = mkdtempSync(join(tmpdir(), "phone-turn-hook-"));
    try {
      const confDir = join(tmp, "conf");
      const lineage = join(tmp, "lineage");
      const bin = join(tmp, "bin");
      const log = join(tmp, "systemctl.log");
      for (const dir of [lineage, bin]) spawnSync("mkdir", ["-p", dir]);
      const rendered = spawnSync("bash", [process.env.PROBE_EDGE_SCRIPT ?? edgeScript, "turn-hook"], {
        env: { PATH: process.env.PATH, HOME: tmp, PHONE_CONFIG_DIR: confDir },
        encoding: "utf8",
      });
      expect(rendered.status, rendered.stderr).toBe(0);
      const hook = join(tmp, "hook.sh");
      writeFileSync(hook, rendered.stdout, { mode: 0o755 });
      writeFileSync(join(bin, "systemctl"), '#!/bin/sh\necho "$*" >> "$SYSTEMCTL_LOG"\n', { mode: 0o755 });

      const turnDir = join(confDir, "tls", "turn");
      const restarts = () =>
        existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes("try-restart")).length : 0;
      const runHook = (domains = "phone-turn.papercusp.com") => {
        const r = spawnSync("sh", [hook], {
          env: { PATH: `${bin}:${process.env.PATH}`, RENEWED_DOMAINS: domains, RENEWED_LINEAGE: lineage, SYSTEMCTL_LOG: log },
          encoding: "utf8",
        });
        expect(r.status, r.stderr).toBe(0);
      };
      writeFileSync(join(lineage, "fullchain.pem"), "CERT-1\n");
      writeFileSync(join(lineage, "privkey.pem"), "KEY-1\n");

      runHook();
      expect(restarts()).toBe(1);
      expect(readFileSync(join(turnDir, "fullchain.pem"), "utf8")).toBe("CERT-1\n");
      expect(statSync(join(turnDir, "privkey.pem")).mode & 0o777).toBe(0o600);

      runHook();
      expect(restarts(), "an unchanged certificate must not restart LiveKit").toBe(1);

      writeFileSync(join(lineage, "privkey.pem"), "KEY-2\n");
      runHook();
      expect(restarts()).toBe(2);
      expect(readFileSync(join(turnDir, "privkey.pem"), "utf8")).toBe("KEY-2\n");

      writeFileSync(join(lineage, "fullchain.pem"), "CERT-OTHER\n");
      runHook("phone-voice.papercusp.com");
      expect(restarts(), "a renewal of another domain is not handed to LiveKit").toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

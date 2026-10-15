import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(ROOT, "apps/operator/scripts/papercusp-dns-reconcile.sh");
const DROPIN = join(
  ROOT,
  "apps/operator/scripts/systemd/papercusp-dns-over-tls.conf",
);
const CHROME_POLICY = join(
  ROOT,
  "apps/operator/scripts/systemd/papercusp-chrome-dns-policy.json",
);
const UNIT_DIR = join(ROOT, "apps/operator/scripts/systemd");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "papercusp-dns-"));
  dirs.push(dir);
  const hosts = join(dir, "hosts");
  const installedDropin = join(dir, "resolved.conf");
  const installedPolicy = join(dir, "chrome-policy.json");
  writeFileSync(
    hosts,
    [
      "127.0.0.1 localhost",
      "192.0.2.8 keep.example papercusp.com # retain the unrelated alias",
      "# ---- BEGIN papercusp-sni-bypass (legacy) ----",
      "127.0.0.11 papercusp.com",
      "127.0.0.12 www.papercusp.com",
      "# ---- END papercusp-sni-bypass ----",
      "203.0.113.7 untouched.example",
      "",
    ].join("\n"),
  );
  return { dir, hosts, installedDropin, installedPolicy };
}

function run(mode: "--apply" | "--check", files: ReturnType<typeof fixture>) {
  return spawnSync("bash", [SCRIPT, mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      PAPERCUSP_DNS_TEST_MODE: "1",
      PAPERCUSP_DNS_HOSTS_FILE: files.hosts,
      PAPERCUSP_DNS_RESOLVED_DROPIN: files.installedDropin,
      PAPERCUSP_DNS_EXPECTED_DROPIN: DROPIN,
      PAPERCUSP_CHROME_POLICY: files.installedPolicy,
      PAPERCUSP_CHROME_POLICY_SOURCE: CHROME_POLICY,
    },
  });
}

function liveCheck(files: ReturnType<typeof fixture>, options: {
  configured?: boolean;
  linkDns?: string;
  active?: string;
  connectionOverride?: string;
} = {}) {
  expect(run("--apply", files).status).toBe(0);
  const bin = join(files.dir, "bin");
  mkdirSync(bin, { recursive: true });
  const commands = {
    nmcli: `if [[ "$2" == GENERAL.CONNECTION ]]; then
  printf '%s\\n' "$TEST_ACTIVE_CONNECTION"
elif [[ "$5" == "$TEST_ACTIVE_CONNECTION" && "$TEST_ACTIVE_CONFIGURED" != 1 ]]; then
  printf 'no\\nno\\n-1\\n'
else
  printf 'yes\\nyes\\n2\\n'
fi`,
    resolvectl: `if [[ "$1" == dns ]]; then
  printf 'Link 4 (wlp183s0):%s\\n' "$TEST_LINK_DNS"
else
  printf 'Protocols: +DNSOverTLS\\n'
fi`,
    systemctl: "printf 'masked\\n'",
    getent: "printf '203.0.113.10 STREAM papercusp.com\\n'",
  };
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  }
  return spawnSync("bash", [SCRIPT, "--check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PAPERCUSP_DNS_TEST_MODE: "0",
      PAPERCUSP_DNS_CONNECTION: options.connectionOverride ?? "",
      PAPERCUSP_DNS_HOSTS_FILE: files.hosts,
      PAPERCUSP_DNS_RESOLVED_DROPIN: files.installedDropin,
      PAPERCUSP_DNS_EXPECTED_DROPIN: DROPIN,
      PAPERCUSP_CHROME_POLICY: files.installedPolicy,
      PAPERCUSP_CHROME_POLICY_SOURCE: CHROME_POLICY,
      TEST_ACTIVE_CONNECTION: options.active ?? "AbeandPearl",
      TEST_ACTIVE_CONFIGURED: options.configured ? "1" : "0",
      TEST_LINK_DNS: options.linkDns ?? "",
    },
  });
}

describe("papercusp direct-DNS reconciler", () => {
  it("rejects DHCP DNS on the active network even when the old profile is configured", () => {
    const files = fixture();
    expect(liveCheck(files).status).not.toBe(0);
    expect(liveCheck(files, { configured: true }).status).toBe(0);
  });

  it("rejects any residual per-link DNS server and a disconnected interface", () => {
    const files = fixture();
    expect(liveCheck(files, { configured: true, linkDns: " 192.168.1.1" }).status).not.toBe(0);
    const disconnected = liveCheck(files, { configured: true, active: "--" });
    expect(disconnected.status).not.toBe(0);
    expect(disconnected.stderr).toContain("no active connection");
  });

  it("preserves an explicitly selected connection", () => {
    expect(liveCheck(fixture(), { connectionOverride: "ExplicitProfile" }).status).toBe(0);
  });

  it("removes the whole legacy bypass block and only the targeted mixed-line alias", () => {
    const files = fixture();
    const result = run("--apply", files);
    expect(result.status, result.stderr).toBe(0);

    const hosts = readFileSync(files.hosts, "utf8");
    expect(hosts).not.toContain("papercusp-sni-bypass");
    expect(hosts).not.toMatch(/\b(?:www\.)?papercusp\.com\b/);
    expect(hosts).toContain("192.0.2.8 keep.example");
    expect(hosts).toContain("203.0.113.7 untouched.example");
    expect(readFileSync(files.installedDropin, "utf8")).toBe(
      readFileSync(DROPIN, "utf8"),
    );
    expect(readFileSync(files.installedPolicy, "utf8")).toBe(
      readFileSync(CHROME_POLICY, "utf8"),
    );
  });

  it("is idempotent once the direct-DNS contract is satisfied", async () => {
    const files = fixture();
    expect(run("--apply", files).status).toBe(0);
    const before = {
      hosts: statSync(files.hosts).mtimeMs,
      dropin: statSync(files.installedDropin).mtimeMs,
      policy: statSync(files.installedPolicy).mtimeMs,
    };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(run("--apply", files).status).toBe(0);
    expect(statSync(files.hosts).mtimeMs).toBe(before.hosts);
    expect(statSync(files.installedDropin).mtimeMs).toBe(before.dropin);
    expect(statSync(files.installedPolicy).mtimeMs).toBe(before.policy);

    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/if \(\( changed \)\); then\s+activate_resolver/);
  });

  it("fails check mode when a papercusp hosts override returns", () => {
    const files = fixture();
    expect(run("--apply", files).status).toBe(0);
    writeFileSync(
      files.hosts,
      `${readFileSync(files.hosts, "utf8")}127.0.0.11 papercusp.com\n`,
    );
    expect(run("--check", files).status).not.toBe(0);
  });

  it("pins authenticated DNS and contains no tunnel implementation", () => {
    const dropin = readFileSync(DROPIN, "utf8");
    expect(dropin).toContain("DNSOverTLS=yes");
    expect(dropin).toContain("1.1.1.1#cloudflare-dns.com");
    expect(dropin).toContain("9.9.9.9#dns.quad9.net");

    const chromePolicy = JSON.parse(readFileSync(CHROME_POLICY, "utf8"));
    expect(chromePolicy).toMatchObject({
      BuiltInDnsClientEnabled: true,
      DnsOverHttpsMode: "secure",
      EncryptedClientHelloEnabled: true,
    });
    expect(chromePolicy.DnsOverHttpsTemplates).toContain("cloudflare-dns.com");

    const systemd = ["service", "path", "timer"]
      .map((suffix) =>
        readFileSync(
          join(UNIT_DIR, `papercusp-dns-reconcile.${suffix}`),
          "utf8",
        ),
      )
      .join("\n");
    expect(systemd).not.toMatch(/ssh|vpn|proxy|tunnel/i);
    expect(systemd).toContain("PathChanged=/etc/hosts");
    expect(systemd).toContain("OnUnitActiveSec=5min");
  });
});

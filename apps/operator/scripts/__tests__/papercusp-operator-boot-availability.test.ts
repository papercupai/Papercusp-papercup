import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SYSTEMD_DIR = join(__dirname, "..", "systemd");
const SCRIPT = join(SYSTEMD_DIR, "papercusp-operator-boot-availability.sh");
const SERVICE = join(SYSTEMD_DIR, "papercusp-operator-boot-availability.service");
const TIMER = join(SYSTEMD_DIR, "papercusp-operator-boot-availability.timer");
const README = join(SYSTEMD_DIR, "README.md");

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "papercusp-operator-boot-availability-"));
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "run");
  const systemctlLog = join(dir, "systemctl.log");
  const curlLog = join(dir, "curl.log");
  await mkdir(binDir);
  await mkdir(stateDir);
  await writeFile(systemctlLog, "");
  await writeFile(curlLog, "");

  await writeFile(
    join(binDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      "set -u",
      'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
      '[[ "$1" == "show" && "$2" == "user@${PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_UID}.service" ]] || exit 2',
      'printf "ActiveState=%s\\nActiveEnterTimestampMonotonic=%s\\n" "$STUB_MANAGER_STATE" "$STUB_MANAGER_START_USEC"',
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    join(binDir, "curl"),
    [
      "#!/usr/bin/env bash",
      "set -u",
      'printf "%s\\n" "$*" >> "$CURL_LOG"',
      '[[ "${STUB_HEALTHY:-0}" == "1" ]] || exit 7',
      "printf '{\"ok\":true}\\n'",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    stateDir,
    systemctlLog,
    curlLog,
    run(options: { nowUsec: number; managerStartUsec?: number; managerState?: string; healthy?: boolean }) {
      return spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SYSTEMCTL_LOG: systemctlLog,
          CURL_LOG: curlLog,
          STUB_MANAGER_STATE: options.managerState ?? "active",
          STUB_MANAGER_START_USEC: String(options.managerStartUsec ?? 100_000_000),
          STUB_HEALTHY: options.healthy ? "1" : "0",
          PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_UID: "1000",
          PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_GRACE_SEC: "600",
          PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_PORT: "3070",
          PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_STATE_DIR: stateDir,
          PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_NOW_USEC: String(options.nowUsec),
        },
      });
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("papercusp operator boot availability check", () => {
  it("waits inside the grace window and probes :3070 from the user-manager start", async () => {
    const fixture = await makeFixture();
    try {
      const result = fixture.run({ nowUsec: 160_000_000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("pending: :3070/api/health is not healthy 60s after user@1000.service start");
      expect(await readFile(fixture.systemctlLog, "utf8")).toContain("show user@1000.service");
      expect(await readFile(fixture.curlLog, "utf8")).toContain("http://127.0.0.1:3070/api/health");
    } finally {
      await fixture.cleanup();
    }
  });

  it("raises one alert when :3070 misses the boot grace and keeps the check idempotent", async () => {
    const fixture = await makeFixture();
    try {
      const first = fixture.run({ nowUsec: 700_000_000 });
      expect(first.status).toBe(1);
      expect(first.stderr).toContain("ALERT: :3070/api/health is still unavailable 600s after user@1000.service started");

      const repeated = fixture.run({ nowUsec: 760_000_000 });
      expect(repeated.status).toBe(1);
      expect(repeated.stderr).toBe("");
    } finally {
      await fixture.cleanup();
    }
  });

  it("records the first healthy sample and stops treating later outages as boot delay", async () => {
    const fixture = await makeFixture();
    try {
      const first = fixture.run({ nowUsec: 220_000_000, healthy: true });
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("healthy: :3070/api/health first succeeded at 120s after user@1000.service started");

      const laterOutage = fixture.run({ nowUsec: 2_000_000_000 });
      expect(laterOutage.status).toBe(0);
      expect(laterOutage.stdout).toContain("boot readiness was already proved");
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not probe before the user manager is active", async () => {
    const fixture = await makeFixture();
    try {
      const result = fixture.run({ nowUsec: 160_000_000, managerState: "activating" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("waiting: user@1000.service is activating");
      expect(await readFile(fixture.curlLog, "utf8")).toBe("");
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not claim a boot measurement when its first healthy sample misses the grace window", async () => {
    const fixture = await makeFixture();
    try {
      const result = fixture.run({ nowUsec: 900_000_000, healthy: true });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("healthy now: :3070/api/health first succeeded at a 800s sample");
      expect(result.stdout).toContain("the 600s startup window was not observed");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("papercusp operator boot availability units", () => {
  it("starts from the user manager timer and does not wait for default.target", async () => {
    const [service, timer] = await Promise.all([readFile(SERVICE, "utf8"), readFile(TIMER, "utf8")]);
    expect(service).toContain("PAPERCUSP_OPERATOR_BOOT_AVAILABILITY_GRACE_SEC=600");
    expect(service).toContain("RestrictAddressFamilies=AF_UNIX AF_INET");
    expect(service).not.toMatch(/^ProtectKernel(Tunables|Modules)=/m);
    expect(service).not.toContain("ProtectControlGroups=");
    expect(service).not.toContain("After=default.target");
    expect(timer).toContain("OnStartupSec=60s");
    expect(timer).toContain("OnUnitActiveSec=60s");
    expect(timer).toContain("WantedBy=timers.target");
    expect(timer).not.toContain("After=default.target");
  });

  it("documents copy-based installation and live verification", async () => {
    const readme = await readFile(README, "utf8");
    expect(readme).toContain("install -Dm0644 papercusp-operator-boot-availability.service");
    expect(readme).toContain("install -Dm0644 papercusp-operator-boot-availability.timer");
    expect(readme).toContain("systemctl --user enable --now papercusp-operator-boot-availability.timer");
    // Copy-based install is deliberate: no `ln -s…` command (continuations joined) may link these units.
    const symlinkInstalls = (text: string) => text.replace(/\\\n\s*/g, " ").split("\n")
      .filter((line) => /\bln\s+-s/.test(line) && line.includes("papercusp-operator-boot-availability"));
    expect(symlinkInstalls('ln -sfn \\\n  "$(pwd)/papercusp-operator-boot-availability.timer" ~/.config/systemd/user/'))
      .toHaveLength(1);
    expect(symlinkInstalls(readme)).toEqual([]);
  });
});

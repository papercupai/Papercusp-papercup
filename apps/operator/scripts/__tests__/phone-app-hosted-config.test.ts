import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicAddress, publicHostname, publicMediaUrl, publicAddresses, loadTestReceipt, localProbeHealthUrl, localPhoneReadiness } from "../../../../infra/phone-app/media-config.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const deployPath = resolve(repoRoot, "infra/phone-app/deploy.sh");
const sidecarUnitPath = resolve(repoRoot, "infra/phone-app/systemd/papercusp-phone-sidecar.service.tmpl");

describe("Phone hosted media deployment contract", () => {
  it("keeps the deploy script syntactically valid", () => {
    const result = spawnSync("bash", ["-n", deployPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("keeps public and internal coordinates separate", () => {
    const source = readFileSync(deployPath, "utf8");
    expect(source).toContain("--hosted");
    expect(source).toContain('upsert_env_var "PHONE_LIVEKIT_URL"');
    expect(source).toContain('upsert_env_var "PHONE_LIVEKIT_PUBLIC_URL"');
    expect(source).toContain("media-config.mjs");
    expect(source).not.toContain("PHONE_LIVEKIT_API_SECRET=%s\\nPHONE_LIVEKIT_URL=ws://127.0.0.1:7890");
  });

  it.each([
    "ws://voice.example.com", "wss://localhost", "wss://127.1", "wss://10.0.0.1",
    "wss://[::1]", "wss://voice.local", "wss://voice.internal", "wss://voice.example.com:7890",
    "wss://user:pass@voice.example.com", "wss://voice.example.com/path", "wss://voice.example.com?key=secret",
    "wss://voice.example.com#token", "wss://voice.exa\nmple.com", "wss://voice.example.com.",
  ])("refuses unsafe browser origin %s", value => {
    expect(() => publicMediaUrl(value)).toThrow();
  });

  it("accepts a secure public DNS origin", () => {
    expect(publicMediaUrl("wss://voice.example.com").hostname).toBe("voice.example.com");
    expect(publicHostname("TURN.EXAMPLE.COM")).toBe("turn.example.com");
  });

  it.each(["127.0.0.1", "10.20.30.40", "172.31.0.1", "192.168.1.1", "100.64.0.1",
    "169.254.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "2001:db8::1", "not-an-ip"])
  ("rejects non-global DNS answer %s", address => expect(isPublicAddress(address)).toBe(false));

  it("accepts global v4 and v6", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects mixed public/private DNS and empty answers", async () => {
    await expect(publicAddresses("voice.example.com", async () => [
      { address: "8.8.8.8" }, { address: "10.0.0.1" },
    ])).rejects.toThrow("exclusively");
    await expect(publicAddresses("voice.example.com", async () => [])).rejects.toThrow("exclusively");
    await expect(publicAddresses("voice.example.com", async () => [
      { address: "8.8.8.8" }, { address: "8.8.8.8" },
    ])).resolves.toEqual(["8.8.8.8"]);
  });
});

// Shape measured from installed lk 2.16.0 against an isolated LiveKit 1.10.1.
const receivedAudio = `Track loading:
│ Tester │ Track │ Kind │ Pkts. │ Bitrate │ Pkt. Loss │
│ Sub 1 │ TR_A123 │ audio │ 147 │ 25.3kbps │ 0 (0%) │
Subscriber summaries:
│ Tester │ Tracks │ Bitrate │ Total Pkt. Loss │ Error │
│ Sub 1 │ 1/1 │ 25.3kbps │ 0 (0%) │ - │
│ Total │ 1/1 │ 25.3kbps (25.3kbps avg) │ 0 (0%) │ 0 │`;

describe('Phone audio receive verdict', () => {
  it('accepts only the measured single-direction audio scope', () => {
    expect(loadTestReceipt(receivedAudio)).toMatchObject({ receivedPackets: 147,
      publicAudioVerified: false, bidirectionalAudioVerified: false });
    expect(loadTestReceipt(receivedAudio.replaceAll('│', '|'))).toMatchObject({ receivedPackets: 147 });
    expect(loadTestReceipt(`\u001b[32m${receivedAudio}\u001b[0m`)).toMatchObject({ receivedPackets: 147 });
  });

  it.each([
    ['keyword-only zero traffic', 'received 0 packets, bitrate 0bps'],
    ['zero received packets', receivedAudio.replace('147', '0')],
    ['zero receive bitrate', receivedAudio.replace('25.3kbps', '0bps')],
    ['video-only traffic', receivedAudio.replace('audio', 'video')],
    ['absent subscriber', receivedAudio.replace('│ Sub 1 │ 1/1', '│ Sub 1 │ 0/1')],
    ['subscriber error', receivedAudio.replace('│ - │', '│ connection failed │')],
    ['total error', receivedAudio.replace('│ 0 │', '│ 1 │')],
    ['wrong subscriber', receivedAudio.replace('│ Sub 1 │ 1/1', '│ Sub 2 │ 1/1')],
    ['unknown header', receivedAudio.replace('Pkts.', 'Sent')],
    ['publisher row', receivedAudio.replace('│ Sub 1 │ TR_', '│ Pub 0 │ TR_')],
    ['duplicate runs', receivedAudio + '\n' + receivedAudio],
    ['missing summary', receivedAudio.split('Subscriber summaries:')[0]],
  ])('refuses %s', (_name, output) => expect(() => loadTestReceipt(output)).toThrow());

  it('derives health only from an explicit local candidate control origin', () => {
    expect(localProbeHealthUrl('ws://127.0.0.1:7890')).toBe('http://127.0.0.1:7890/');
    expect(localProbeHealthUrl('ws://[::1]:18000')).toBe('http://[::1]:18000/');
    for (const url of ['wss://voice.example.com', 'ws://127.0.0.1:7880',
      'ws://localhost:7890', 'ws://127.0.0.1:7890?key=secret', 'ws://secret@127.0.0.1:7890']) {
      expect(() => localProbeHealthUrl(url)).toThrow();
    }
  });
});

describe('Phone local readiness is fail-closed and scoped', () => {
  const coordinates = { PHONE_LIVEKIT_URL: 'ws://127.0.0.1:7890',
    PHONE_SIDECAR_URL: 'ws://127.0.0.1:8793', PHONE_WORKER_SECRET: 'worker-fixture-secret' };
  it('observes four service units and two HTTP endpoints without asserting public calls', async () => {
    const units: string[] = [], urls: string[] = [];
    const result = await localPhoneReadiness(coordinates, {
      unitState: async (unit: string) => { units.push(unit); return true; },
      httpReady: async (url: string) => { urls.push(url); return true; },
      httpStatus: async () => 401,
    });
    expect(result).toMatchObject({ ok: true, scope: 'local-process-and-http-only',
      publicPhoneVerified: false, bidirectionalAudioVerified: false,
      recoveryVerified: false, costPolicyVerified: false });
    expect(units).toEqual([
      'papercusp-phone-livekit.service', 'papercusp-phone-sip.service',
      'papercusp-phone-worker.service', 'papercusp-phone-sidecar.service',
    ]);
    expect(urls).toEqual(['http://127.0.0.1:7890/', 'http://127.0.0.1:8793/api/health']);
  });
  it('refuses inactive/crashed units, HTTP faults and unknown probes', async () => {
    const base = { unitState: async () => true, httpReady: async () => true, httpStatus: async () => 401 };
    const sipFailure = await localPhoneReadiness(coordinates, {
      ...base, unitState: async (unit: string) => unit !== 'papercusp-phone-sip.service',
    });
    expect(sipFailure.ok).toBe(false);
    expect(sipFailure.alerts).toEqual([{
      component: 'sip', owner: 'phone-operations',
      action: expect.stringContaining('papercusp-phone-sip.service'),
    }]);
    const workerAndMedia = await localPhoneReadiness(coordinates, {
      ...base, unitState: async (unit: string) =>
        !['papercusp-phone-worker.service', 'papercusp-phone-livekit.service'].includes(unit),
    });
    expect(workerAndMedia.alerts.map(alert => alert.component)).toEqual(['media', 'worker']);
    expect(workerAndMedia.alerts.every(alert => alert.action && alert.owner === 'phone-operations')).toBe(true);
    const sidecarFailure = await localPhoneReadiness(coordinates, {
      ...base, httpReady: async (url: string) => !url.includes('8793'),
    });
    expect(sidecarFailure.ok).toBe(false);
    expect(sidecarFailure.alerts).toMatchObject([{
      component: 'sidecar-http', action: expect.stringContaining('/api/health'),
    }]);
    expect((await localPhoneReadiness(coordinates, {
      ...base, unitState: async () => { throw new Error('systemctl failed'); },
    })).ok).toBe(false);
    expect((await localPhoneReadiness({ ...coordinates, PHONE_SIDECAR_URL: 'wss://example.com' }, base)).ok).toBe(false);
    expect((await localPhoneReadiness({ PHONE_LIVEKIT_URL: '' }, base)).ok).toBe(false);
  });
  // WI-10006645: a blank PHONE_WORKER_SECRET left every unit and health endpoint
  // green while the worker reported nothing and the sidecar refused all ingest.
  it('fails worker-ingest unless the secret is configured AND the sidecar refuses an unauthenticated probe 401', async () => {
    const base = { unitState: async () => true, httpReady: async () => true };
    const probed: string[] = [];
    const armed = await localPhoneReadiness(coordinates, {
      ...base, httpStatus: async (url: string) => { probed.push(url); return 401; },
    });
    expect(armed.ok).toBe(true);
    expect(armed.checks).toContainEqual({ component: 'worker-ingest', ready: true });
    expect(probed).toEqual(['http://127.0.0.1:8793/internal/readiness']);
    // The live 2026-10-06 state: the sidecar booted without the secret.
    const disabled = await localPhoneReadiness(coordinates, { ...base, httpStatus: async () => 503 });
    expect(disabled.ok).toBe(false);
    expect(disabled.alerts).toEqual([{ component: 'worker-ingest', owner: 'phone-operations',
      action: expect.stringContaining('PHONE_WORKER_SECRET') }]);
    // An unauthenticated probe that is ADMITTED means the guard is gone, not ready.
    expect((await localPhoneReadiness(coordinates, { ...base, httpStatus: async () => 200 })).ok).toBe(false);
    for (const secret of [undefined, '', '   ']) {
      const asked: string[] = [];
      const unset = await localPhoneReadiness({ ...coordinates, PHONE_WORKER_SECRET: secret }, {
        ...base, httpStatus: async (url: string) => { asked.push(url); return 401; },
      });
      expect(unset.ok, `secret=${JSON.stringify(secret)}`).toBe(false);
      expect(unset.alerts.map(alert => alert.component)).toEqual(['worker-ingest']);
      expect(asked).toEqual([]);
    }
    expect((await localPhoneReadiness(coordinates, {
      ...base, httpStatus: async () => { throw new Error('connection refused'); },
    })).ok).toBe(false);
  });
});

describe('Phone sidecar supervision', () => {
  it('lets systemd observe the sidecar child exit and retry failed startup', () => {
    const unit = readFileSync(sidecarUnitPath, 'utf8');
    expect(unit).toMatch(/^ExecStart=\$\{PHONE_NODE_BIN\} --import tsx src\/index\.ts$/m);
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).not.toMatch(/^ExecStart=.*--watch/m);
    expect(readFileSync(deployPath, 'utf8')).toContain('systemctl --user restart "$u"');
  });
});

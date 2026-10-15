import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOSTED_LOGIN_CHOICE,
  HOSTED_RECONNECT_POLLS,
  HOSTED_RECONNECT_POLL_MS,
  PSU_CONNECTION_STORE_VERSION,
  defaultPsuConnectionStorePath,
  hostedForwardInput,
  loadPsuConnectionStore,
  normalizeAwsSsmProfile,
  normalizeGcpIapProfile,
  normalizeHostedPortalOrigin,
  normalizeHostedProfile,
  parsePsuConnectionArgs,
  runPsuConnectionFrontController,
  savePsuConnectionStore,
} from "./psu-connection-front-controller.mjs";

const PORTAL = "https://portal.example.test";
const TOKEN = `pct_${"a".repeat(43)}`;
const NEW_TOKEN = `pct_${"b".repeat(43)}`;
const TICKET = `ht_${"t".repeat(43)}`;

function hostedProfile(accessToken = TOKEN) {
  return normalizeHostedProfile({
    origin: PORTAL,
    accessToken,
    tokenId: "hct_token-1",
    organizationId: "e91577da-655b-4b24-b122-ab57b4f9d211",
    userId: "user_01",
    expiresAt: "2026-10-24T00:00:00.000Z",
  });
}

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A scripted portal: each handler answers one path; calls are recorded in order. */
function fakePortal(
  handlers: Record<string, (call: FetchCall) => { status: number; body: unknown }>,
) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: FetchCall = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected request ${path}`);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status });
  });
  return { fetch, calls };
}

function savedStore(home: string, profiles: unknown[]) {
  const storePath = defaultPsuConnectionStorePath(home);
  savePsuConnectionStore(
    { version: PSU_CONNECTION_STORE_VERSION, profiles },
    storePath,
  );
  return storePath;
}

const WORKSPACES = {
  "/api/hosted/cli/workspaces": () => ({
    status: 200,
    body: {
      ok: true,
      workspaces: [
        { id: "ws-live", displayName: "avi-test", state: "active", reachable: true },
        { id: "ws-stopped", displayName: "old", state: "stopped", reachable: false },
      ],
    },
  }),
};

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "papercusp-psu-connections-"));
  roots.push(root);
  return root;
}

function gcpProfile(name = "cloud") {
  return normalizeGcpIapProfile({
    name,
    projectId: "papercusp-dev-123",
    zone: "us-central1-a",
    instanceName: "workspace-1",
    sshUser: "alice_example_com",
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("psu connection transport argv", () => {
  it("strips only transport flags and preserves every other argv cell in exact order", () => {
    const parsed = parsePsuConnectionArgs([
      "--connect",
      "cloud",
      "--resume=session 1",
      "--fork",
      "--model=gpt-5.6-sol:xhigh",
      "--",
      "--connect=owned-by-remote-psu",
      "",
    ]);

    expect(parsed.transport).toMatchObject({
      explicitConnect: true,
      selection: "cloud",
    });
    expect(parsed.forwardedArgv).toEqual([
      "--resume=session 1",
      "--fork",
      "--model=gpt-5.6-sol:xhigh",
      "--",
      "--connect=owned-by-remote-psu",
      "",
    ]);
  });

  it("parses namespaced GCP IAP profile maintenance without claiming remote psu flags", () => {
    const parsed = parsePsuConnectionArgs([
      "--connect-add-gcp-iap=cloud",
      "--connect-project=papercusp-dev-123",
      "--connect-zone",
      "us-central1-a",
      "--connect-instance=workspace-1",
      "--connect-user=alice_example_com",
      "--account=default",
    ]);
    expect(parsed.transport).toMatchObject({
      addName: "cloud",
      projectId: "papercusp-dev-123",
      zone: "us-central1-a",
      instanceName: "workspace-1",
      sshUser: "alice_example_com",
    });
    expect(parsed.forwardedArgv).toEqual(["--account=default"]);
  });
});

describe("psu connection profile store", () => {
  it("persists a versioned normalized GCP-IAP-only store with private permissions", () => {
    const path = defaultPsuConnectionStorePath(tempHome());
    savePsuConnectionStore(
      { version: PSU_CONNECTION_STORE_VERSION, profiles: [gcpProfile()] },
      path,
    );

    expect(loadPsuConnectionStore(path)).toEqual({
      version: PSU_CONNECTION_STORE_VERSION,
      profiles: [gcpProfile()],
    });
    if (process.platform !== "win32")
      expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("normalizes GCP to IAP with declared capabilities and rejects shell-shaped provider identity", () => {
    const profile = gcpProfile();
    expect(profile).toMatchObject({
      kind: "gcp-iap-ssh",
      target: "alice_example_com@workspace-1",
      features: {
        command: true,
        pty: true,
        tcpForward: true,
        fileTransfer: true,
      },
      audited: true,
    });
    expect(profile.endpoint).toContain("gcp-iap-ssh://");
    expect(profile.constraints.join(" ")).toContain("No public IP");
    expect(() =>
      normalizeGcpIapProfile({
        ...profile,
        projectId: "project; touch /tmp/bad",
      }),
    ).toThrow("GCP project id");
  });
});

describe("psu remote front controller", () => {
  it("reuses a ControlMaster, probes the forwarded operator, and lets remote psu own every launch picker", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    savePsuConnectionStore(
      { version: PSU_CONNECTION_STORE_VERSION, profiles: [gcpProfile()] },
      storePath,
    );
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const interactive: Array<{ command: string; args: readonly string[] }> = [];
    const probes: string[] = [];
    const runCommand = vi.fn(
      async (command: string, args: readonly string[]) => {
        commands.push({ command, args });
        if (args.includes("check")) return { code: 1, signal: null };
        return { code: 0, signal: null };
      },
    );

    const result = await runPsuConnectionFrontController(
      [
        "--connect=cloud",
        "--role=su",
        "--resume=session 1",
        "--fork",
        "--account=auto",
        "--",
        "--backend-owned=value with spaces",
      ],
      {
        home,
        storePath,
        interactive: false,
        commandAvailable: () => true,
        runCommand,
        async runInteractive(command: string, args: readonly string[]) {
          interactive.push({ command, args });
          return { code: 0, signal: null };
        },
        async reservePort() {
          return { port: 45123, async release() {} };
        },
        async probeOperator(origin: string) {
          probes.push(origin);
        },
        notice: vi.fn(),
      },
    );

    expect(result).toEqual({
      handled: true,
      argv: [
        "--role=su",
        "--resume=session 1",
        "--fork",
        "--account=auto",
        "--",
        "--backend-owned=value with spaces",
      ],
      exitCode: 0,
    });
    expect(probes).toEqual(["http://127.0.0.1:45123"]);
    expect(
      commands.some(({ args }) => args.includes("ControlMaster=yes")),
    ).toBe(true);
    expect(
      commands.some(({ args }) =>
        args.some((arg) => arg.includes("start-iap-tunnel workspace-1")),
      ),
    ).toBe(true);
    expect(commands.at(-1)?.args).toContain("cancel");
    expect(interactive).toHaveLength(1);
    expect(interactive[0]?.args).toContain("-tt");
    expect(interactive[0]?.args.at(-1)).toContain(
      `'env' 'PAPERCUSP_PSU_CONNECTION_FORWARDED=1' 'psu' '--role=su' '--resume=session 1' '--fork' '--account=auto' '--' '--backend-owned=value with spaces'`,
    );
  });

  it("bypasses transport parsing after the local controller forwards into remote psu", async () => {
    const home = tempHome();
    await expect(
      runPsuConnectionFrontController(["--connect=backend-owned", "--resume"], {
        home,
        transportForwarded: true,
      }),
    ).resolves.toEqual({
      handled: false,
      argv: ["--connect=backend-owned", "--resume"],
    });
  });

  it("keeps a scripted invocation local by default without changing argv", async () => {
    const home = tempHome();
    await expect(
      runPsuConnectionFrontController(["--no-picker", "--agent=codex"], {
        home,
        interactive: false,
      }),
    ).resolves.toEqual({
      handled: false,
      argv: ["--no-picker", "--agent=codex"],
    });
  });

  it("keeps launcher help local and side-effect-free without claiming backend help", async () => {
    const home = tempHome();
    const pickConnection = vi.fn(async () => {
      throw new Error(
        "the connection picker must not run for local launcher help",
      );
    });

    await expect(
      runPsuConnectionFrontController(["--help"], {
        home,
        interactive: true,
        pickConnection,
      }),
    ).resolves.toEqual({ handled: false, argv: ["--help"] });
    expect(pickConnection).not.toHaveBeenCalled();

    await expect(
      runPsuConnectionFrontController(["--", "--help"], {
        home,
        interactive: true,
        pickConnection: async () => "local",
      }),
    ).resolves.toEqual({ handled: false, argv: ["--", "--help"] });
  });
});

describe("psu --connect over AWS SSM (aws-byoc-gcp-parity-2026-10-01 P-009)", () => {
  const INSTANCE = "i-0123456789abcdef0";
  const SSM_PROXY =
    "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --region=us-east-2 --profile=papercusp-byoc";

  function awsProfile(name = "ec2") {
    return normalizeAwsSsmProfile({
      name,
      region: "us-east-2",
      instanceId: INSTANCE,
      sshUser: "ec2-user",
      awsProfile: "papercusp-byoc",
    });
  }

  /** Records every ssh call; the ControlMaster check fails so a new master is built. */
  function sshRecorder() {
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const interactive: Array<{ command: string; args: readonly string[] }> = [];
    return {
      commands,
      interactive,
      runCommand: vi.fn(async (command: string, args: readonly string[]) => {
        commands.push({ command, args });
        return { code: args.includes("check") ? 1 : 0, signal: null };
      }),
      async runInteractive(command: string, args: readonly string[]) {
        interactive.push({ command, args });
        return { code: 0, signal: null };
      },
    };
  }

  function option(args: readonly string[], name: string): string | undefined {
    const hit = args.find(
      (arg, index) => args[index - 1] === "-o" && arg.startsWith(`${name}=`),
    );
    return hit?.slice(name.length + 1);
  }

  it("parses the AWS add command and forwards every other argv cell", () => {
    const parsed = parsePsuConnectionArgs([
      "--connect-add-aws-ssm=ec2",
      "--connect-region",
      "us-east-2",
      `--connect-instance=${INSTANCE}`,
      "--connect-user=ec2-user",
      "--connect-aws-profile=papercusp-byoc",
      "--account=default",
    ]);
    expect(parsed.transport).toMatchObject({
      addAwsName: "ec2",
      addName: null,
      region: "us-east-2",
      instanceName: INSTANCE,
      sshUser: "ec2-user",
      awsProfile: "papercusp-byoc",
    });
    expect(parsed.forwardedArgv).toEqual(["--account=default"]);
  });

  it("refuses a provider field that belongs to the other provider's add command", () => {
    expect(() =>
      parsePsuConnectionArgs(["--connect-add-gcp-iap=g", "--connect-region=us-east-2"]),
    ).toThrow("--connect-region/aws-profile require --connect-add-aws-ssm");
    expect(() =>
      parsePsuConnectionArgs(["--connect-add-aws-ssm=a", "--connect-zone=us-central1-a"]),
    ).toThrow("--connect-project/zone require --connect-add-gcp-iap");
    expect(() =>
      parsePsuConnectionArgs(["--connect-add-aws-ssm=a", "--connect-add-gcp-iap=g"]),
    ).toThrow("Choose only one of");
    expect(() => parsePsuConnectionArgs([`--connect-instance=${INSTANCE}`])).toThrow(
      "--connect-instance/user require --connect-add-gcp-iap or --connect-add-aws-ssm",
    );
  });

  it("normalizes an SSM profile with declared capabilities and rejects shell-shaped identity", () => {
    const profile = awsProfile();
    expect(profile).toMatchObject({
      kind: "aws-ssm-ssh",
      region: "us-east-2",
      instanceId: INSTANCE,
      awsProfile: "papercusp-byoc",
      target: `ec2-user@${INSTANCE}`,
      features: { command: true, pty: true, tcpForward: true, fileTransfer: true },
      audited: true,
    });
    expect(profile.endpoint).toBe(
      `aws-ssm-ssh://${INSTANCE}?region=us-east-2&instance=${INSTANCE}&profile=papercusp-byoc`,
    );
    expect(profile.prerequisites).toContain("AWS Session Manager plugin");
    expect(profile.constraints.join(" ")).toContain("No public IP");
    // No awsProfile key at all when none is given, so the default chain is used.
    expect("awsProfile" in normalizeAwsSsmProfile({ ...profile, awsProfile: undefined })).toBe(false);
    expect(() => normalizeAwsSsmProfile({ ...profile, instanceId: "i-123; touch /tmp/bad" })).toThrow(
      "EC2 instance id",
    );
    expect(() => normalizeAwsSsmProfile({ ...profile, region: "us-east-2 --debug" })).toThrow(
      "AWS region",
    );
    expect(() => normalizeAwsSsmProfile({ ...profile, awsProfile: "p --endpoint-url=x" })).toThrow(
      "AWS CLI profile",
    );
  });

  it("stores AWS beside GCP profiles and reloads both unchanged", () => {
    const path = savedStore(tempHome(), [gcpProfile("gcp"), awsProfile("aws")]);
    expect(loadPsuConnectionStore(path).profiles).toEqual([gcpProfile("gcp"), awsProfile("aws")]);
  });

  it("saves the profile from the add command and lists it", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    const output: string[] = [];
    await expect(
      runPsuConnectionFrontController(
        [
          "--connect-add-aws-ssm=ec2",
          "--connect-region=us-east-2",
          `--connect-instance=${INSTANCE}`,
          "--connect-user=ec2-user",
          "--connect-aws-profile=papercusp-byoc",
        ],
        { home, storePath, interactive: false, output: (line: string) => output.push(line) },
      ),
    ).resolves.toMatchObject({ handled: true, exitCode: 0 });
    expect(loadPsuConnectionStore(storePath).profiles).toEqual([awsProfile()]);
    expect(output).toEqual([
      `Saved ec2 — AWS SSM us-east-2/${INSTANCE} as ec2-user (AWS profile papercusp-byoc)`,
    ]);
  });

  it("opens remote psu through an SSM-tunnelled ControlMaster to the instance id", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [awsProfile()]);
    const ssh = sshRecorder();
    const checked: string[] = [];

    const result = await runPsuConnectionFrontController(
      ["--connect=ec2", "--role=su", "--", "--backend-owned"],
      {
        home,
        storePath,
        interactive: false,
        commandAvailable: (command: string) => {
          checked.push(command);
          return true;
        },
        runCommand: ssh.runCommand,
        runInteractive: ssh.runInteractive,
        async reservePort() {
          return { port: 45124, async release() {} };
        },
        async probeOperator() {},
        notice: vi.fn(),
      },
    );

    expect(result).toEqual({
      handled: true,
      argv: ["--role=su", "--", "--backend-owned"],
      exitCode: 0,
    });
    expect(checked).toEqual(["ssh", "aws", "session-manager-plugin"]);
    const master = ssh.commands.find(({ args }) => args.includes("ControlMaster=yes"));
    expect(master?.command).toBe("ssh");
    expect(option(master?.args ?? [], "ProxyCommand")).toBe(SSM_PROXY);
    expect(master?.args).toContain(`ec2-user@${INSTANCE}`);
    expect(master?.args.join(" ")).not.toContain("gcloud");
    expect(ssh.interactive[0]?.args.at(-1)).toContain(
      `'env' 'PAPERCUSP_PSU_CONNECTION_FORWARDED=1' 'psu' '--role=su' '--' '--backend-owned'`,
    );
  });

  it("refuses before any ssh call when the Session Manager plugin is missing", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [awsProfile()]);
    const ssh = sshRecorder();
    await expect(
      runPsuConnectionFrontController(["--connect=ec2"], {
        home,
        storePath,
        interactive: false,
        commandAvailable: (command: string) => command !== "session-manager-plugin",
        runCommand: ssh.runCommand,
      }),
    ).rejects.toThrow("Connection 'ec2' requires 'session-manager-plugin' on the local PATH");
    expect(ssh.commands).toEqual([]);
  });

  it("names the SSM permission, not IAP or OS Login, when the tunnel cannot be established", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [awsProfile()]);
    await expect(
      runPsuConnectionFrontController(["--connect=ec2"], {
        home,
        storePath,
        interactive: false,
        commandAvailable: () => true,
        runCommand: async () => ({ code: 255, signal: null }),
        async reservePort() {
          return { port: 45125, async release() {} };
        },
        notice: vi.fn(),
      }),
    ).rejects.toThrow(/ssm:StartSession with AWS-StartSSHSession\.$/);
  });
});

describe("psu Papercusp cloud connections (WI-10002874)", () => {
  it("parses sign-in, sign-out and workspace selection without claiming remote psu flags", () => {
    expect(parsePsuConnectionArgs(["--connect-login", "--role=su"])).toMatchObject({
      transport: { login: true, loginOrigin: null },
      forwardedArgv: ["--role=su"],
    });
    expect(
      parsePsuConnectionArgs([`--connect-login=${PORTAL}`]).transport.loginOrigin,
    ).toBe(PORTAL);
    expect(parsePsuConnectionArgs(["--connect-logout"]).transport).toMatchObject({
      logout: true,
      logoutName: null,
    });
    expect(
      parsePsuConnectionArgs([
        "--connect=portal.example.test/ws-live",
        "--connect-session",
        "abc_1",
        "--resume",
      ]),
    ).toMatchObject({
      transport: {
        explicitConnect: true,
        selection: "portal.example.test/ws-live",
        sessionKey: "abc_1",
      },
      forwardedArgv: ["--resume"],
    });
    expect(() => parsePsuConnectionArgs(["--connect-login", "--connect=x"])).toThrow(
      "cannot also use --connect",
    );
    expect(() =>
      parsePsuConnectionArgs(["--connect-login", "--connect-session=abc"]),
    ).toThrow("cannot also use --connect");
    // Bare --connect beside --connect-login = sign in, then connect there.
    expect(
      parsePsuConnectionArgs(["--connect-program=pui", "--connect-login", "--connect"]),
    ).toMatchObject({
      transport: { login: true, explicitConnect: true, selection: null, program: "pui" },
      forwardedArgv: [],
    });
    expect(() => parsePsuConnectionArgs(["--connect-session=bad key"])).toThrow(
      "--connect-session",
    );
  });

  it("stores a cloud sign-in privately and refuses a non-https or credential-bearing portal", () => {
    const path = savedStore(tempHome(), [gcpProfile(), hostedProfile()]);
    expect(loadPsuConnectionStore(path).profiles).toEqual([gcpProfile(), hostedProfile()]);
    if (process.platform !== "win32")
      expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(hostedProfile()).toMatchObject({
      name: "portal.example.test",
      kind: "papercusp-hosted",
      features: { pty: true, tcpForward: false },
    });
    expect(normalizeHostedPortalOrigin("http://127.0.0.1:3880/x")).toBe(
      "http://127.0.0.1:3880",
    );
    expect(() => normalizeHostedPortalOrigin("http://portal.example.test")).toThrow(
      "https://",
    );
    expect(() =>
      normalizeHostedPortalOrigin("https://portal.example.test@evil.example"),
    ).toThrow("credentials");
    expect(() => hostedProfile("pct_short")).toThrow("Papercusp CLI token");
  });

  it("signs in with a device code, honours pending and slow_down, and saves the token", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    const polls = ["authorization_pending", "slow_down"];
    const portal = fakePortal({
      "/api/hosted/cli/device/code": () => ({
        status: 200,
        body: {
          ok: true,
          deviceCode: `pdc_${"d".repeat(43)}`,
          userCode: "BCDF-GHJK",
          verificationUri: `${PORTAL}/api/hosted/cli/device`,
          verificationUriComplete: `${PORTAL}/api/hosted/cli/device?user_code=BCDF-GHJK`,
          expiresIn: 600,
          interval: 5,
        },
      }),
      "/api/hosted/cli/device/token": () => {
        const next = polls.shift();
        if (next) return { status: 400, body: { ok: false, error: next } };
        return {
          status: 200,
          body: {
            ok: true,
            accessToken: NEW_TOKEN,
            tokenId: "hct_new",
            organizationId: "org-1",
            userId: "user_01",
            expiresAt: "2026-10-24T00:00:00.000Z",
          },
        };
      },
    });
    const sleeps: number[] = [];
    const notices: string[] = [];
    const openBrowser = vi.fn();

    const result = await runPsuConnectionFrontController([`--connect-login=${PORTAL}`], {
      home,
      storePath,
      interactive: true,
      hostname: "laptop",
      fetch: portal.fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      openBrowser,
      notice: (line: string) => notices.push(line),
      output: vi.fn(),
    });

    expect(result).toEqual({ handled: true, argv: [], exitCode: 0 });
    expect(portal.calls[0]?.body).toEqual({ clientLabel: "laptop" });
    expect(sleeps).toEqual([5_000, 5_000, 10_000]);
    expect(openBrowser).toHaveBeenCalledWith(
      `${PORTAL}/api/hosted/cli/device?user_code=BCDF-GHJK`,
    );
    expect(notices.join("\n")).toContain("BCDF-GHJK");
    expect(loadPsuConnectionStore(storePath).profiles).toEqual([
      normalizeHostedProfile({
        origin: PORTAL,
        accessToken: NEW_TOKEN,
        tokenId: "hct_new",
        organizationId: "org-1",
        userId: "user_01",
        expiresAt: "2026-10-24T00:00:00.000Z",
      }),
    ]);
  });

  it("reports a denied sign-in without saving anything", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    const portal = fakePortal({
      "/api/hosted/cli/device/code": () => ({
        status: 200,
        body: {
          ok: true,
          deviceCode: `pdc_${"d".repeat(43)}`,
          userCode: "BCDF-GHJK",
          verificationUriComplete: `${PORTAL}/api/hosted/cli/device?user_code=BCDF-GHJK`,
          expiresIn: 600,
          interval: 5,
        },
      }),
      "/api/hosted/cli/device/token": () => ({
        status: 400,
        body: { ok: false, error: "access_denied" },
      }),
    });
    await expect(
      runPsuConnectionFrontController([`--connect-login=${PORTAL}`], {
        home,
        storePath,
        interactive: false,
        fetch: portal.fetch,
        sleep: async () => {},
        notice: vi.fn(),
      }),
    ).rejects.toThrow("denied");
    expect(loadPsuConnectionStore(storePath).profiles).toEqual([]);
  });

  it("on an older cloud that ignores `program`, uses its shell ticket at the trusted portal with the interim line, forwarding every argv cell", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [hostedProfile()]);
    const portal = fakePortal({
      ...WORKSPACES,
      "/api/hosted/cli/workspaces/ws-live/terminal": ({ body }) => ({
        status: 200,
        body: {
          ok: true,
          // A reply naming a different host must not redirect the terminal there.
          socketUrl: `wss://elsewhere.example/api/hosted/connectors/socket?ticket=${TICKET}`,
          session: (body as { session: string }).session,
          expiresAt: "2026-09-24T05:00:00.000Z",
        },
      }),
    });
    const terminals: Array<{ socketUrl: string; initialInput: string }> = [];
    const run = () =>
      runPsuConnectionFrontController(
        ["--connect=portal.example.test", "--agent=codex", "--label=it's mine"],
        {
          home,
          storePath,
          interactive: false,
          fetch: portal.fetch,
          notice: vi.fn(),
          async openHostedTerminal(input: { socketUrl: string; initialInput: string }) {
            terminals.push(input);
            return { exit: { code: 0, signal: 0 }, resumed: false };
          },
        },
      );

    await expect(run()).resolves.toEqual({
      handled: true,
      argv: ["--agent=codex", "--label=it's mine"],
      exitCode: 0,
    });
    await run();

    expect(portal.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // psu asked for itself; the reply did not say `psu`, so no psu kind is requested.
    expect(portal.calls.find((call) => call.url.endsWith("/terminal"))?.body).toMatchObject({
      program: "psu",
      argv: ["--agent=codex", "--label=it's mine"],
    });
    expect(terminals[0]?.socketUrl).toBe(
      `wss://portal.example.test/api/hosted/connectors/socket?ticket=${TICKET}`,
    );
    expect(terminals[0]?.initialInput).toBe(
      `printf '\\033[H\\033[2J'; ` +
        `command -v psu >/dev/null && exec env PAPERCUSP_PSU_CONNECTION_FORWARDED=1 psu '--agent=codex' '--label=it'\\''s mine'; ` +
        `printf '%s\\n' 'psu cannot start on this cloud workspace yet, so you are in its shell. Start agents from New Session in the portal; type exit to leave.'\r`,
    );
    const sessions = portal.calls
      .filter((call) => call.url.endsWith("/terminal"))
      .map((call) => (call.body as { session: string }).session);
    // Same command, same shell: a rerun reattaches instead of starting over.
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sessions[1]).toBe(sessions[0]);
  });

  describe("the machine starts psu itself (D-002)", () => {
    const psuReply = ({ body }: { body: unknown }) => ({
      status: 200,
      body: {
        ok: true,
        socketUrl: `wss://elsewhere.example/api/hosted/connectors/socket?ticket=${TICKET}&kind=psu`,
        session: (body as { session: string }).session,
        program: (body as { program?: string }).program === "psu" ? "psu" : "shell",
      },
    });
    type Opened = { socketUrl: string; initialInput: string | null; expectKind?: string };
    function connect(
      argv: string[],
      results: Array<Record<string, unknown>>,
      reply: (input: { body: unknown }) => { status: number; body: unknown } = psuReply,
    ) {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      const portal = fakePortal({ ...WORKSPACES, "/api/hosted/cli/workspaces/ws-live/terminal": reply });
      const terminals: Opened[] = [];
      const notice = vi.fn();
      const run = runPsuConnectionFrontController(["--connect=portal.example.test/ws-live", ...argv], {
        home,
        storePath,
        interactive: false,
        fetch: portal.fetch,
        notice,
        async openHostedTerminal(input: Opened) {
          terminals.push(input);
          return results.shift() ?? { exit: { code: 0, signal: 0 }, bound: true };
        },
      });
      const bodies = () =>
        portal.calls.filter((call) => call.url.endsWith("/terminal")).map((call) => call.body as Record<string, unknown>);
      return { run, terminals, bodies, notice };
    }

    it("asks for the psu kind with the argv and types nothing", async () => {
      const t = connect(["--agent", "codex"], [{ exit: { code: 3, signal: 0 }, bound: true }]);
      await expect(t.run).resolves.toEqual({ handled: true, argv: ["--agent", "codex"], exitCode: 3 });
      expect(t.bodies()).toEqual([expect.objectContaining({ program: "psu", argv: ["--agent", "codex"] })]);
      const url = new URL(t.terminals[0]!.socketUrl);
      expect(url.origin).toBe("wss://portal.example.test");
      expect(url.searchParams.get("kind")).toBe("psu");
      expect(JSON.parse(url.searchParams.get("argv")!)).toEqual(["--agent", "codex"]);
      expect(t.terminals[0]).toMatchObject({ initialInput: null, expectKind: "psu" });
    });

    it.each(["unknown", "unanswered", "degraded"])(
      "falls back to the interim shell line on a fresh shell ticket when the machine cannot start psu (%s)",
      async (kindUnavailable) => {
        const t = connect(["--no-picker"], [{ bound: false, kindUnavailable }]);
        await expect(t.run).resolves.toMatchObject({ handled: true, exitCode: 0 });
        expect(t.bodies().map((body) => body.program)).toEqual(["psu", undefined]);
        expect(t.bodies()[1]!.session).toBe(t.bodies()[0]!.session);
        expect(new URL(t.terminals[1]!.socketUrl).searchParams.has("kind")).toBe(false);
        expect(t.terminals[1]!.initialInput).toBe(hostedForwardInput("psu", ["--no-picker"]));
        expect(t.notice).toHaveBeenCalledWith(expect.stringContaining(`cannot start psu for you yet (${kindUnavailable})`));
      },
    );

    it("refuses a flag outside the allowlist before asking the cloud for anything", async () => {
      const t = connect(["--role=su"], []);
      await expect(t.run).rejects.toThrow(
        "psu on a Papercusp cloud workspace takes only --agent, --model, --label, --no-picker, --resume and --fork; --role is not available there.",
      );
      expect(t.bodies()).toEqual([]);
      expect(t.terminals).toEqual([]);
    });

    it("names the flag when the cloud refuses the argv", async () => {
      const t = connect(["--model=x"], [], () => ({
        status: 400,
        body: { ok: false, error: { code: "psu_argv_refused", reason: "flag_value_refused:--model" } },
      }));
      await expect(t.run).rejects.toThrow("that --model value is not accepted there.");
      expect(t.terminals).toEqual([]);
    });

    it("says psu, not a shell, keeps running when the relay drops", async () => {
      const t = connect([], [{ exit: null, bound: true, closeCode: 1006, closeReason: "gone" }]);
      await expect(t.run).rejects.toThrow("psu keeps running on the machine for a while");
    });
  });

  describe("the line typed into the workspace shell, run by a real bash (WI-10003949)", () => {
    // PATH is only `bin`: this box has a real psu in /usr/bin. The remote
    // terminal turns the typed CR into a newline; a pipe does not.
    const typeInto = (bin: string, line: string) =>
      spawnSync("/bin/bash", ["--norc", "--noprofile", "-s"], {
        input: `${line.replace(/\r$/, "\n")}echo still-in-shell\n`,
        env: { PATH: bin },
        encoding: "utf8",
      });

    it("stays in the shell and says why when the machine has no psu", () => {
      const result = typeInto(tempHome(), hostedForwardInput("psu", ["--role=su"]));

      // The screen is cleared first, wiping the echoed copies of the typed line.
      expect(result.stdout).toBe(
        "\x1b[H\x1b[2J" +
          "psu cannot start on this cloud workspace yet, so you are in its shell. Start agents from New Session in the portal; type exit to leave.\n" +
          "still-in-shell\n",
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("replaces the shell with psu, marked forwarded, with every argv cell intact", () => {
      const bin = tempHome();
      writeFileSync(
        join(bin, "psu"),
        '#!/bin/sh\necho "forwarded=$PAPERCUSP_PSU_CONNECTION_FORWARDED"\nfor cell in "$@"; do echo "[$cell]"; done\nexit 7\n',
      );
      chmodSync(join(bin, "psu"), 0o755);
      symlinkSync("/usr/bin/env", join(bin, "env"));

      const result = typeInto(bin, hostedForwardInput("psu", ["--role=su", "--label=it's mine", "a b"]));

      expect(result.stdout).toBe("\x1b[H\x1b[2Jforwarded=1\n[--role=su]\n[--label=it's mine]\n[a b]\n");
      expect(result.status).toBe(7);
    });
  });

  it("names the resume command when the relay drops before the remote shell exits", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [hostedProfile()]);
    const portal = fakePortal({
      ...WORKSPACES,
      "/api/hosted/cli/workspaces/ws-live/terminal": () => ({
        status: 200,
        body: {
          ok: true,
          socketUrl: `wss://portal.example.test/api/hosted/connectors/socket?ticket=${TICKET}`,
          session: "sess_1",
        },
      }),
    });
    await expect(
      runPsuConnectionFrontController(["--connect=portal.example.test/ws-live"], {
        home,
        storePath,
        interactive: false,
        fetch: portal.fetch,
        notice: vi.fn(),
        openHostedTerminal: async () => ({
          exit: null,
          bound: true,
          closeCode: 1006,
          closeReason: "connector_lost",
        }),
      }),
    ).rejects.toThrow(
      "psu --connect=portal.example.test/ws-live --connect-session=sess_1",
    );
  });

  describe("when the workspace machine's link to Papercusp cloud is down (WI-10003909)", () => {
    const NOW = Date.parse("2026-09-29T17:00:00.000Z");
    const THREE_MIN_AGO = new Date(NOW - 180_000).toISOString();
    const linkDown = {
      id: "ws-live",
      displayName: "avi-test",
      state: "active",
      reachable: false,
      connectorHeartbeatAt: THREE_MIN_AGO,
    };
    const live = { ...linkDown, reachable: true, connectorHeartbeatAt: new Date(NOW).toISOString() };
    const listing = (...rounds: Array<Array<Record<string, unknown>>>) => {
      let round = 0;
      return () => ({
        status: 200,
        body: { ok: true, workspaces: rounds[Math.min(round++, rounds.length - 1)] },
      });
    };
    const ticketReply = () => ({
      status: 200,
      body: {
        ok: true,
        socketUrl: `wss://portal.example.test/api/hosted/connectors/socket?ticket=${TICKET}`,
        session: "sess_1",
      },
    });
    const harness = (
      home: string,
      storePath: string,
      fetch: ReturnType<typeof fakePortal>["fetch"],
    ) => {
      const sleeps: number[] = [];
      const notices: string[] = [];
      return {
        sleeps,
        notices,
        deps: {
          home,
          storePath,
          interactive: false,
          fetch,
          now: () => NOW,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
          notice: (line: string) => {
            notices.push(line);
          },
        },
      };
    };
    const paths = (calls: FetchCall[]) => calls.map((call) => new URL(call.url).pathname);

    it("says the machine is running but its link is down, waits for it, then attaches", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      const portal = fakePortal({
        "/api/hosted/cli/workspaces": listing([linkDown], [linkDown], [live]),
        "/api/hosted/cli/workspaces/ws-live/terminal": ticketReply,
      });
      const { deps, sleeps, notices } = harness(home, storePath, portal.fetch);

      await expect(
        runPsuConnectionFrontController(["--connect=portal.example.test/ws-live"], {
          ...deps,
          openHostedTerminal: async () => ({ exit: { code: 0, signal: 0 }, bound: true }),
        }),
      ).resolves.toMatchObject({ handled: true, exitCode: 0 });

      expect(notices[0]).toBe(
        `psu: ws-live is running, but its link to Papercusp cloud is down, last heard 3 min ago; waiting up to ${(HOSTED_RECONNECT_POLLS * HOSTED_RECONNECT_POLL_MS) / 1000}s for it to reconnect`,
      );
      expect(notices).toContain("psu: ws-live reconnected to Papercusp cloud");
      expect(sleeps).toEqual([HOSTED_RECONNECT_POLL_MS, HOSTED_RECONNECT_POLL_MS]);
      expect(paths(portal.calls)).toEqual([
        "/api/hosted/cli/workspaces",
        "/api/hosted/cli/workspaces",
        "/api/hosted/cli/workspaces",
        "/api/hosted/cli/workspaces/ws-live/terminal",
      ]);
    });

    it("gives up after the bounded wait with the truth, never a resume hint", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      const portal = fakePortal({
        "/api/hosted/cli/workspaces": listing([linkDown]),
      });
      const { deps, sleeps } = harness(home, storePath, portal.fetch);
      const openHostedTerminal = vi.fn();

      const failure = runPsuConnectionFrontController(["--connect=portal.example.test/ws-live"], {
        ...deps,
        openHostedTerminal,
      });
      await expect(failure).rejects.toThrow(
        "Workspace 'ws-live' is running, but its link to Papercusp cloud is down, last heard 3 min ago, and it did not reconnect while psu waited",
      );
      await expect(failure).rejects.not.toThrow("--connect-session");
      expect(sleeps).toHaveLength(HOSTED_RECONNECT_POLLS);
      expect(openHostedTerminal).not.toHaveBeenCalled();
      expect(paths(portal.calls)).not.toContain("/api/hosted/cli/workspaces/ws-live/terminal");
    });

    it("still refuses a stopped workspace at once, without waiting", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      const portal = fakePortal({
        "/api/hosted/cli/workspaces": listing([{ ...linkDown, state: "stopped" }]),
      });
      const { deps, sleeps } = harness(home, storePath, portal.fetch);
      await expect(
        runPsuConnectionFrontController(["--connect=portal.example.test/ws-live"], deps),
      ).rejects.toThrow("'ws-live' is not connected right now (stopped). Start it in the portal");
      expect(sleeps).toEqual([]);
    });

    it("retries with a fresh ticket when the terminal is refused because the link just dropped", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      let opens = 0;
      const portal = fakePortal({
        "/api/hosted/cli/workspaces": listing([live], [live]),
        "/api/hosted/cli/workspaces/ws-live/terminal": () =>
          ++opens === 1
            ? {
                status: 409,
                body: {
                  ok: false,
                  error: { code: "workspace_not_reachable", connectorHeartbeatAt: THREE_MIN_AGO },
                },
              }
            : ticketReply(),
      });
      const { deps, notices } = harness(home, storePath, portal.fetch);

      await expect(
        runPsuConnectionFrontController(["--connect=portal.example.test/ws-live"], {
          ...deps,
          openHostedTerminal: async () => ({ exit: { code: 0, signal: 0 }, bound: true }),
        }),
      ).resolves.toMatchObject({ handled: true, exitCode: 0 });
      expect(opens).toBe(2);
      expect(notices[0]).toContain("its link to Papercusp cloud is down, last heard 3 min ago");
    });

    it("treats 4411 before a shell bound as the machine reconnecting: waits and reattaches", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      const portal = fakePortal({
        "/api/hosted/cli/workspaces": listing([live]),
        "/api/hosted/cli/workspaces/ws-live/terminal": ticketReply,
      });
      const { deps } = harness(home, storePath, portal.fetch);
      const results = [
        { exit: null, bound: false, closeCode: 4411, closeReason: "connector_unavailable" },
        { exit: { code: 0, signal: 0 }, bound: true },
      ];
      const openHostedTerminal = vi.fn(async () => results.shift());

      await expect(
        runPsuConnectionFrontController(["--connect=portal.example.test/ws-live"], {
          ...deps,
          openHostedTerminal,
        }),
      ).resolves.toMatchObject({ handled: true, exitCode: 0 });
      expect(openHostedTerminal).toHaveBeenCalledTimes(2);
      expect(paths(portal.calls).filter((path) => path.endsWith("/terminal"))).toHaveLength(2);
    });

    it("offers --connect-session only when a shell actually started", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      const portal = fakePortal({
        "/api/hosted/cli/workspaces": listing([live]),
        "/api/hosted/cli/workspaces/ws-live/terminal": ticketReply,
      });
      const { deps } = harness(home, storePath, portal.fetch);
      const run = (result: Record<string, unknown>) =>
        runPsuConnectionFrontController(["--connect=portal.example.test/ws-live"], {
          ...deps,
          openHostedTerminal: async () => result,
        });

      const dropped = run({
        exit: null,
        bound: true,
        closeCode: 4412,
        closeReason: "connector_disconnected",
      });
      await expect(dropped).rejects.toThrow(
        "The workspace machine's link to Papercusp cloud dropped (connector_disconnected)",
      );
      await expect(dropped).rejects.toThrow(
        "psu --connect=portal.example.test/ws-live --connect-session=sess_1",
      );

      const neverStarted = run({ exit: null, bound: false, closeCode: 1006, closeReason: "" });
      await expect(neverStarted).rejects.toThrow(
        "The connection to ws-live closed before a shell started. Nothing was started there",
      );
      await expect(neverStarted).rejects.not.toThrow("--connect-session");
    });

    it("names link-down workspaces when none is reachable and no workspace was chosen", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      const portal = fakePortal({
        "/api/hosted/cli/workspaces": listing([linkDown]),
      });
      const { deps, sleeps } = harness(home, storePath, portal.fetch);
      await expect(
        runPsuConnectionFrontController(["--connect=portal.example.test"], deps),
      ).rejects.toThrow(
        `None of your workspaces at ${PORTAL} is reachable right now: ws-live is running, but its link to Papercusp cloud is down, last heard 3 min ago.`,
      );
      expect(sleeps).toEqual([]);
    });
  });

  it("turns an expired sign-in and a stopped workspace into actionable errors", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [hostedProfile()]);
    const expired = fakePortal({
      "/api/hosted/cli/workspaces": () => ({
        status: 401,
        body: { ok: false, error: { code: "cli_token_invalid" } },
      }),
    });
    await expect(
      runPsuConnectionFrontController(["--connect=portal.example.test"], {
        home,
        storePath,
        interactive: false,
        fetch: expired.fetch,
        notice: vi.fn(),
      }),
    ).rejects.toThrow(`psu --connect-login=${PORTAL}`);

    const stopped = fakePortal(WORKSPACES);
    await expect(
      runPsuConnectionFrontController(["--connect=portal.example.test/ws-stopped"], {
        home,
        storePath,
        interactive: false,
        fetch: stopped.fetch,
        notice: vi.fn(),
        openHostedTerminal: vi.fn(),
      }),
    ).rejects.toThrow("'ws-stopped' is not connected right now (stopped)");
    expect(stopped.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/hosted/cli/workspaces",
    ]);
  });

  it("offers cloud sign-in from a plain interactive psu and lists workspaces once signed in", async () => {
    const home = tempHome();
    const storePath = savedStore(home, []);
    const seen: Array<Array<{ value: string; disabled?: string }>> = [];
    await runPsuConnectionFrontController([], {
      home,
      storePath,
      interactive: true,
      pickConnection: async (choices: Array<{ value: string }>) => {
        seen.push(choices);
        return "local";
      },
    });
    expect(seen[0]?.map((choice) => choice.value)).toEqual(["local", HOSTED_LOGIN_CHOICE]);

    savedStore(home, [hostedProfile()]);
    const portal = fakePortal(WORKSPACES);
    await runPsuConnectionFrontController([], {
      home,
      storePath,
      interactive: true,
      fetch: portal.fetch,
      pickConnection: async (choices: Array<{ value: string }>) => {
        seen.push(choices);
        return "local";
      },
    });
    expect(seen[1]).toEqual([
      expect.objectContaining({ value: "local" }),
      expect.objectContaining({ value: "portal.example.test/ws-live" }),
      expect.objectContaining({
        value: "portal.example.test/ws-stopped",
        disabled: "not connected",
      }),
      // WI-10003910: signing in to a second account or organization is always on offer.
      {
        name: "Sign in to another Papercusp cloud account or organization",
        value: HOSTED_LOGIN_CHOICE,
      },
    ]);
  });

  describe("several cloud sign-ins at once (WI-10003910)", () => {
    const deviceCode = () => ({
      status: 200,
      body: {
        ok: true,
        deviceCode: `pdc_${"d".repeat(43)}`,
        userCode: "BCDF-GHJK",
        verificationUri: `${PORTAL}/api/hosted/cli/device`,
        verificationUriComplete: `${PORTAL}/api/hosted/cli/device?user_code=BCDF-GHJK`,
        expiresIn: 600,
        interval: 5,
      },
    });
    const issuing = (identity: { organizationId: string; organizationName?: string; userId: string }) => () => ({
      status: 200,
      body: {
        ok: true,
        accessToken: NEW_TOKEN,
        tokenId: "hct_new",
        expiresAt: "2026-10-24T00:00:00.000Z",
        ...identity,
      },
    });
    const signIn = async (
      home: string,
      storePath: string,
      identity: { organizationId: string; organizationName?: string; userId: string },
    ) => {
      const portal = fakePortal({
        "/api/hosted/cli/device/code": deviceCode,
        "/api/hosted/cli/device/token": issuing(identity),
        "/api/hosted/cli/logout": () => ({ status: 200, body: { ok: true } }),
      });
      const output: string[] = [];
      await runPsuConnectionFrontController([`--connect-login=${PORTAL}`], {
        home,
        storePath,
        interactive: false,
        fetch: portal.fetch,
        sleep: async () => {},
        notice: vi.fn(),
        output: (line: string) => output.push(line),
      });
      return { portal, output };
    };

    it("keeps a second organization's sign-in beside the first, named for that organization", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [hostedProfile()]);
      const { portal, output } = await signIn(home, storePath, {
        organizationId: "0c6f3a52-1111-4222-8333-944445555666",
        organizationName: "Acme Robotics",
        userId: "user_01",
      });

      const profiles = loadPsuConnectionStore(storePath).profiles;
      expect(profiles.map((profile: { name: string }) => profile.name)).toEqual([
        "portal.example.test",
        "portal.example.test-acme-robotics",
      ]);
      expect(profiles[0]).toEqual(hostedProfile());
      expect(profiles[1]).toMatchObject({
        organizationId: "0c6f3a52-1111-4222-8333-944445555666",
        organizationName: "Acme Robotics",
        accessToken: NEW_TOKEN,
      });
      // The first sign-in's token is untouched: nothing was signed out.
      expect(portal.calls.map((call) => new URL(call.url).pathname)).not.toContain(
        "/api/hosted/cli/logout",
      );
      expect(output[0]).toBe(
        "Signed in to https://portal.example.test for Acme Robotics as 'portal.example.test-acme-robotics'. Run psu --connect=portal.example.test-acme-robotics to open psu on one of your workspaces.",
      );
    });

    it("replaces only the SAME portal + organization + user, and signs the old token out", async () => {
      const home = tempHome();
      const original = hostedProfile();
      const storePath = savedStore(home, [original]);
      const { portal } = await signIn(home, storePath, {
        organizationId: original.organizationId,
        userId: original.userId,
      });

      const profiles = loadPsuConnectionStore(storePath).profiles;
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({ name: "portal.example.test", accessToken: NEW_TOKEN });
      const logout = portal.calls.find((call) => call.url.endsWith("/hosted/cli/logout"));
      expect(logout?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("tells two users of one organization apart, and never takes a machine profile's name", async () => {
      const home = tempHome();
      const machine = normalizeGcpIapProfile({
        name: "portal.example.test",
        projectId: "papercusp-dev-123",
        zone: "us-central1-a",
        instanceName: "workspace-1",
        sshUser: "alice_example_com",
      });
      const storePath = savedStore(home, [machine]);
      const org = "0c6f3a52-1111-4222-8333-944445555666";
      await signIn(home, storePath, { organizationId: org, organizationName: "Acme", userId: "user_01" });
      await signIn(home, storePath, { organizationId: org, organizationName: "Acme", userId: "user_02" });

      expect(
        loadPsuConnectionStore(storePath).profiles.map((profile: { name: string }) => profile.name),
      ).toEqual([
        "portal.example.test",
        "portal.example.test-acme",
        "portal.example.test-acme-user-02",
      ]);
    });

    it("labels each sign-in's workspaces with its organization, preferring the cloud's current name", async () => {
      const home = tempHome();
      const storePath = savedStore(home, [
        normalizeHostedProfile({ ...hostedProfile(), organizationName: "Old Name" }),
      ]);
      const portal = fakePortal({
        "/api/hosted/cli/workspaces": () => ({
          status: 200,
          body: {
            ok: true,
            organizationName: "Acme Robotics",
            workspaces: [{ id: "ws-live", displayName: "avi-test", state: "active", reachable: true }],
          },
        }),
      });
      const output: string[] = [];
      await runPsuConnectionFrontController(["--connect-list"], {
        home,
        storePath,
        interactive: false,
        fetch: portal.fetch,
        notice: vi.fn(),
        output: (line: string) => output.push(line),
      });
      expect(output).toContain(
        "portal.example.test — Papercusp cloud workspaces at https://portal.example.test for Old Name",
      );
      expect(output).toContain(
        "  portal.example.test/ws-live — Papercusp cloud workspace avi-test (ws-live) in Acme Robotics",
      );
    });

    it("strips control characters from an organization name before it reaches the terminal", () => {
      const profile = normalizeHostedProfile({
        ...hostedProfile(),
        organizationName: "Evil\u001b[2JCorp\n",
      });
      expect(profile.organizationName).toBe("Evil [2JCorp");
    });
  });

  it("signs out by revoking the token and forgetting the profile", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [gcpProfile(), hostedProfile()]);
    const portal = fakePortal({
      "/api/hosted/cli/logout": () => ({ status: 200, body: { ok: true } }),
    });
    await expect(
      runPsuConnectionFrontController(["--connect-logout"], {
        home,
        storePath,
        fetch: portal.fetch,
        output: vi.fn(),
      }),
    ).resolves.toEqual({ handled: true, argv: [], exitCode: 0 });
    expect(portal.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(loadPsuConnectionStore(storePath).profiles).toEqual([gcpProfile()]);
  });
});

describe("pui through psu's saved connections (P-017)", () => {
  it("consumes --connect-program and refuses a program it does not run", () => {
    expect(
      parsePsuConnectionArgs(["--connect-program=pui", "--connect=cloud", "workbench"]),
    ).toMatchObject({
      transport: { program: "pui", selection: "cloud" },
      forwardedArgv: ["workbench"],
    });
    expect(parsePsuConnectionArgs(["--role=su"]).transport.program).toBe("psu");
    expect(() => parsePsuConnectionArgs(["--connect-program=bash"])).toThrow(
      "--connect-program must be one of psu, pui",
    );
  });

  it("runs pui on a cloud workspace in its own shell, never reattaching psu's", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [hostedProfile()]);
    const portal = fakePortal({
      ...WORKSPACES,
      "/api/hosted/cli/workspaces/ws-live/terminal": ({ body }) => ({
        status: 200,
        body: {
          ok: true,
          socketUrl: `wss://portal.example.test/api/hosted/connectors/socket?ticket=${TICKET}`,
          session: (body as { session: string }).session,
        },
      }),
    });
    const terminals: Array<{ initialInput: string }> = [];
    const run = (argv: string[]) =>
      runPsuConnectionFrontController(argv, {
        home,
        storePath,
        interactive: false,
        fetch: portal.fetch,
        notice: vi.fn(),
        async openHostedTerminal(input: { initialInput: string }) {
          terminals.push(input);
          return { exit: { code: 0, signal: 0 }, resumed: false };
        },
      });

    // The same argv for both programs, so only the program can tell the sessions apart. The
    // portal replies without `program`, so psu takes the interim shell line too (D-002 rule 5).
    await expect(
      run(["--connect-program=pui", "--connect=portal.example.test", "--no-picker"]),
    ).resolves.toEqual({ handled: true, argv: ["--no-picker"], exitCode: 0 });
    await run(["--connect=portal.example.test", "--no-picker"]);

    expect(terminals[0]?.initialInput).toBe(hostedForwardInput("pui", ["--no-picker"]));
    expect(terminals[1]?.initialInput).toBe(hostedForwardInput("psu", ["--no-picker"]));
    const [pui, psu] = portal.calls
      .filter((call) => call.url.endsWith("/terminal"))
      .map((call) => (call.body as { session: string }).session);
    expect(pui).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(pui).not.toBe(psu);
  });

  it("runs pui over IAP SSH in a tmux session named for pui", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [gcpProfile()]);
    const interactive: Array<readonly string[]> = [];
    await runPsuConnectionFrontController(
      ["--connect-program=pui", "--connect=cloud", "workbench"],
      {
        home,
        storePath,
        interactive: false,
        commandAvailable: () => true,
        runCommand: async (_command: string, args: readonly string[]) => ({
          code: args.includes("check") ? 1 : 0,
          signal: null,
        }),
        async runInteractive(_command: string, args: readonly string[]) {
          interactive.push(args);
          return { code: 0, signal: null };
        },
        async reservePort() {
          return { port: 45124, async release() {} };
        },
        async probeOperator() {},
        notice: vi.fn(),
      },
    );
    const remote = interactive[0]?.at(-1) ?? "";
    expect(remote).toMatch(/'papercusp-pui-[0-9a-f]{16}'/);
    expect(remote).toContain(
      `'env' 'PAPERCUSP_PSU_CONNECTION_FORWARDED=1' 'pui' 'workbench'`,
    );
  });

  it("names the cloud's refusal code when a sign-in cannot start, and says the fault is not local (WI-10003292)", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    const portal = fakePortal({
      "/api/hosted/cli/device/code": () => ({
        status: 401,
        body: { ok: false, error: "portal_auth_required" },
      }),
    });
    const notice = vi.fn();
    const failure = runPsuConnectionFrontController(["--connect-login", PORTAL], {
      home,
      storePath,
      interactive: false,
      hostname: "laptop",
      fetch: portal.fetch,
      sleep: async () => {},
      openBrowser: vi.fn(),
      output: vi.fn(),
      notice,
    });
    await expect(failure).rejects.toThrow(
      `Cannot start a Papercusp cloud sign-in at ${PORTAL} (HTTP 401 portal_auth_required).`,
    );
    await expect(failure).rejects.toThrow(/nothing on this machine caused it/);
    // No code was printed: the user is never told to open a page that cannot work.
    expect(notice).not.toHaveBeenCalled();
    expect(portal.calls).toHaveLength(1);
  });

  it("signs in and then opens pui on the new sign-in's workspace (PUI first-run, D-031)", async () => {
    const home = tempHome();
    const storePath = defaultPsuConnectionStorePath(home);
    const portal = fakePortal({
      "/api/hosted/cli/device/code": () => ({
        status: 200,
        body: {
          ok: true,
          deviceCode: `pdc_${"d".repeat(43)}`,
          userCode: "BCDF-GHJK",
          verificationUriComplete: `${PORTAL}/api/hosted/cli/device?user_code=BCDF-GHJK`,
          expiresIn: 600,
          interval: 1,
        },
      }),
      "/api/hosted/cli/device/token": () => ({
        status: 200,
        body: {
          ok: true,
          accessToken: NEW_TOKEN,
          tokenId: "hct_new",
          organizationId: "org-1",
          userId: "user_01",
          expiresAt: "2026-10-24T00:00:00.000Z",
        },
      }),
      ...WORKSPACES,
      "/api/hosted/cli/workspaces/ws-live/terminal": ({ body }) => ({
        status: 200,
        body: {
          ok: true,
          socketUrl: `wss://portal.example.test/api/hosted/connectors/socket?ticket=${TICKET}`,
          session: (body as { session: string }).session,
        },
      }),
    });
    const terminals: Array<{ socketUrl: string; initialInput: string }> = [];
    const output = vi.fn();
    // No origin on the command line: the portal comes from PAPERCUSP_CLOUD_ORIGIN.
    vi.stubEnv("PAPERCUSP_CLOUD_ORIGIN", PORTAL);
    try {
      await expect(
        runPsuConnectionFrontController(
          ["--connect-program=pui", "--connect-login", "--connect"],
          {
            home,
            storePath,
            interactive: true,
            hostname: "laptop",
            fetch: portal.fetch,
            sleep: async () => {},
            openBrowser: vi.fn(),
            pickConnection: async () => {
              throw new Error("one connected workspace needs no picker");
            },
            output,
            notice: vi.fn(),
            async openHostedTerminal(input: { socketUrl: string; initialInput: string }) {
              terminals.push(input);
              return { exit: { code: 0, signal: 0 }, resumed: false };
            },
          },
        ),
      ).resolves.toEqual({ handled: true, argv: [], exitCode: 0 });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(portal.calls[0]?.url).toBe(`${PORTAL}/api/hosted/cli/device/code`);
    // The freshly issued token, not a stale one, authorizes the workspace calls.
    const listed = portal.calls.find((call) => call.url.endsWith("/cli/workspaces"));
    expect(listed?.headers.authorization).toBe(`Bearer ${NEW_TOKEN}`);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.initialInput).toBe(hostedForwardInput("pui", []));
    // Sign-in-then-connect does not print the "now run --connect" hint.
    expect(output).not.toHaveBeenCalled();
    expect(loadPsuConnectionStore(storePath).profiles.map((profile: { name: string }) => profile.name)).toEqual([
      "portal.example.test",
    ]);
  });

  it("offers pui no 'this computer' entry and refuses to fall back to a local launch", async () => {
    const home = tempHome();
    const storePath = savedStore(home, [gcpProfile()]);
    const seen: Array<{ values: string[]; program?: string }> = [];
    const pick =
      (answer: string | null) =>
      async (choices: Array<{ value: string }>, options?: { program?: string }) => {
        seen.push({ values: choices.map((choice) => choice.value), program: options?.program });
        return answer;
      };

    for (const answer of ["local", null]) {
      await expect(
        runPsuConnectionFrontController(["--connect-program=pui", "--connect"], {
          home,
          storePath,
          interactive: true,
          pickConnection: pick(answer),
        }),
      ).rejects.toThrow("run pui without --connect to stay on this computer");
    }
    await expect(
      runPsuConnectionFrontController(["--connect-program=pui", "--connect=local"], {
        home,
        storePath,
        interactive: false,
      }),
    ).rejects.toThrow("run pui without --connect to stay on this computer");
    expect(seen[0]).toEqual({
      values: ["cloud", HOSTED_LOGIN_CHOICE],
      program: "pui",
    });
  });
});

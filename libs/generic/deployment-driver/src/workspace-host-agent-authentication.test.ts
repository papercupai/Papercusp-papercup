import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES,
  NodeWorkspaceHostAgentProbeRunner,
  WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER,
  WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER,
  WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER,
  WORKSPACE_HOST_CANARY_AGENTS,
  applyWorkspaceHostAgentRuntimePath,
  buildWorkspaceHostAgentProbeProcess,
  classifyWorkspaceHostAgentProbeFailure,
  probeWorkspaceHostAgentVerification,
  probeWorkspaceHostAgents,
  workspaceHostAgentSpecSatisfiesReadiness,
  workspaceHostAgentSubjectDigest,
  type WorkspaceHostAgentProbeInvocation,
  type WorkspaceHostAgentProbeOutcome,
  type WorkspaceHostAgentProbeRunner,
  type WorkspaceHostCanaryAgent,
} from "./workspace-host-agent-authentication";

const NOW = () => new Date("2026-08-25T22:30:00.000Z");
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_SOURCE = resolve(PACKAGE_ROOT, "workspace-host-agent-authentication.ts");

class ScriptedRunner implements WorkspaceHostAgentProbeRunner {
  readonly invocations: WorkspaceHostAgentProbeInvocation[] = [];

  constructor(
    private readonly script: Record<
      string,
      WorkspaceHostAgentProbeOutcome | Error
    >,
  ) {}

  run(
    invocation: WorkspaceHostAgentProbeInvocation,
  ): Promise<WorkspaceHostAgentProbeOutcome> {
    this.invocations.push(invocation);
    const scripted = this.script[invocation.command];
    if (!scripted)
      return Promise.reject(new Error(`no script for ${invocation.command}`));
    if (scripted instanceof Error) return Promise.reject(scripted);
    return Promise.resolve(scripted);
  }
}

const AUTHENTICATED = {
  claude: {
    exitCode: 0,
    // WI-10001689: claude's probe is live-inference now, so a PASSING run is the marker alone on
    // its own line, not an account line. `claude auth status` never contacted the endpoint it
    // declared — measured, it reported a fabricated subject from a hand-written config file — so
    // it could not establish that a delivered credential actually authenticates.
    stdout: `${WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER}\n`,
  },
  codex: {
    exitCode: 0,
    // WI-10001694: codex's readiness now comes from live-inference ONLY — its account probe is
    // `satisfiesReadiness: false`. ScriptedRunner keys by COMMAND and both codex specs shell the
    // same one, so this single outcome serves both probes: the account line feeds the
    // evidence-only subject digest, and the marker on its own line is what actually makes codex
    // ready. Carrying BOTH is deliberate rather than convenient — an account line PLUS a working
    // credential is exactly the arrangement the old short-circuit made dangerous, so a fixture
    // with the marker alone would stop exercising the case this flag exists to defuse.
    stdout: `Login status: signed in as canary@papercup.ai (Team)\n${WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER}\n`,
  },
  omp: {
    exitCode: 0,
    stdout: JSON.stringify({
      providers: [{ id: "anthropic", accounts: [{ account: "can…4f2" }] }],
    }),
  },
} satisfies Record<WorkspaceHostCanaryAgent, WorkspaceHostAgentProbeOutcome>;

describe("workspace-host agent verification probes", () => {
  it("typechecks the spawn boundary with a host-required NodeJS.ProcessEnv augmentation", () => {
    const configPath = join(PACKAGE_ROOT, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const options = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      PACKAGE_ROOT,
      { noEmit: true, skipLibCheck: true, types: ["node"] },
      configPath,
    ).options;
    const virtualEntry = resolve(PACKAGE_ROOT, "__consumer_probe__.ts");
    const virtualGlobals = resolve(PACKAGE_ROOT, "__consumer_globals__.d.ts");
    const virtualFiles = new Map([
      [
        virtualEntry,
        "import { NodeWorkspaceHostAgentProbeRunner } from " +
          JSON.stringify(PROBE_SOURCE) +
          ";\nvoid NodeWorkspaceHostAgentProbeRunner;\n",
      ],
      [
        virtualGlobals,
        "declare namespace NodeJS { interface ProcessEnv { readonly NODE_ENV: \"development\" | \"production\" | \"test\"; } }\n",
      ],
    ]);
    const host = ts.createCompilerHost(options, true);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (fileName) => virtualFiles.has(resolve(fileName)) || fileExists(fileName);
    host.readFile = (fileName) => virtualFiles.get(resolve(fileName)) ?? readFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const source = virtualFiles.get(resolve(fileName));
      return source === undefined
        ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, source, languageVersion, true);
    };
    const program = ts.createProgram({
      rootNames: [virtualEntry, virtualGlobals],
      options,
      host,
    });
    const sourceDiagnostics = ts.getPreEmitDiagnostics(program).filter(
      (diagnostic) => diagnostic.file?.fileName === PROBE_SOURCE,
    );

    expect(sourceDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    }))).toEqual([]);
  });

  it("probes only explicitly requested agents without claiming all-agent readiness", async () => {
    const runner = new ScriptedRunner(AUTHENTICATED);
    const report = await probeWorkspaceHostAgents({ runner, now: NOW, requestedAgents: ["claude", "omp"] });
    expect(runner.invocations.map((entry) => entry.command)).toEqual(["claude", "omp"]);
    expect(report.requestedAgents).toEqual(["claude", "omp"]);
    expect(Object.keys(report.agents)).toEqual(["claude", "omp"]);
    expect(report.agents.claude?.ready).toBe(true);
    expect(report.agents.omp?.ready).toBe(true);
    expect(report.allReady).toBe(false);
  });

  it.each([[], Array(1), ["claude", "claude"], ["unknown"], null, "claude"].map((requestedAgents) => ({ requestedAgents })))(
    "rejects malformed requested-agent coverage before invoking a runtime: %j",
    async ({ requestedAgents }) => {
      const runner = new ScriptedRunner(AUTHENTICATED);
      await expect(probeWorkspaceHostAgents({ runner, requestedAgents: requestedAgents as never })).rejects.toThrow(/requestedAgents/);
      expect(runner.invocations).toEqual([]);
    },
  );

  it("uses a real account or inference verb for every agent, never a version check", () => {
    for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
      for (const spec of DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES[
        agent
      ]) {
        expect(spec.agent).toBe(agent);
        expect(spec.args.length).toBeGreaterThan(0);
        expect(spec.args).not.toContain("--version");
        expect(spec.args).not.toContain("-v");
        expect(spec.endpoint.length).toBeGreaterThan(0);
      }
    }
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
    ).toMatchObject({
      verificationKind: "live-inference",
      command: "claude",
      endpoint: "https://api.anthropic.com",
    });
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0].args,
    ).toEqual([
      "-p",
      "--strict-mcp-config",
      "--no-session-persistence",
      `Reply with exactly ${WORKSPACE_HOST_CLAUDE_LIVE_INFERENCE_MARKER} and nothing else.`,
    ]);
    // WI-10001689 RECURRENCE GUARD. `claude auth status` must not come back in ANY position.
    // Measured: it never contacts the endpoint it declares, and an entirely invented access token
    // beside a hand-written oauthAccount block matched SUBJECT_PATTERN — so it certifies only that
    // a writable JSON file exists. Restoring it FIRST would be worst of all: the probe loop breaks
    // on the first ready spec, so it would short-circuit the live-inference probe below it and
    // silently return the gate to proving nothing.
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude.some(
        (spec) => spec.args.includes("auth") && spec.args.includes("status"),
      ),
    ).toBe(false);
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[0].args,
    ).toEqual(["login", "status"]);
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp[0].args,
    ).toEqual(["usage", "--json", "--redact"]);
    expect(
      DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp[1],
    ).toMatchObject({
      verificationKind: "local-inference",
      command: "omp",
      endpoint: "http://127.0.0.1:11434",
    });
  });

  // WI-10001689: these two exercise the account-subject DISCLOSURE machinery, so they must run
  // against an agent whose probe still yields an account subject. They used claude until claude
  // moved to live-inference, whose proof is a fixed marker — keeping them there would have left
  // them asserting that a non-secret constant does not leak, which is no assertion at all. codex
  // keeps `authenticated-account` with the same `digest` disclosure, so the property under test
  // is unchanged and still has a real email to protect.
  it("reports authenticated with only the four permitted discriminators", async () => {
    const runner = new ScriptedRunner({ codex: AUTHENTICATED.codex });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[0],
      runner,
      now: NOW,
    });

    expect(evidence.ready).toBe(true);
    expect(evidence.verificationKind).toBe("authenticated-account");
    expect(evidence.exitStatus).toBe(0);
    expect(evidence.endpoint).toBe("https://api.openai.com");
    expect(evidence.observedAt).toBe("2026-08-25T22:30:00.000Z");
    expect(evidence.proofDigest).toBe(
      workspaceHostAgentSubjectDigest("canary@papercup.ai"),
    );
  });

  it("never lets raw stdout or an un-redacted subject reach the evidence", async () => {
    const runner = new ScriptedRunner({ codex: AUTHENTICATED.codex });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[0],
      runner,
      now: NOW,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("canary@papercup.ai");
    expect(serialized).not.toContain("Login status");
    // codex's disclosure is `digest`, so no plaintext subject is published at all.
    expect(evidence.subject).toBeUndefined();
  });

  // WI-10001689: claude's own evidence shape, now that it proves a credential by USING it.
  it("reports claude ready from a live-inference marker, not an account line", async () => {
    const runner = new ScriptedRunner({ claude: AUTHENTICATED.claude });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });

    expect(evidence.ready).toBe(true);
    expect(evidence.verificationKind).toBe("live-inference");
    expect(evidence.exitStatus).toBe(0);
    expect(evidence.endpoint).toBe("https://api.anthropic.com");
  });

  // WI-10001689. The failure this replaced was silent: `claude auth status` exits 0 and prints a
  // subject for a credential the server would reject, so the gate read "ready". Under
  // live-inference the server itself is the judge — measured against a real credential (exit 0,
  // marker) and an invented one (exit 1, `401 OAuth access token is invalid`).
  it("reports claude NOT ready when the credential is rejected by the server", async () => {
    const runner = new ScriptedRunner({
      claude: {
        exitCode: 1,
        stdout: "Failed to authenticate. API Error: 401 OAuth access token is invalid.\n",
      },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });

    expect(evidence.ready).toBe(false);
  });

  it("publishes the subject verbatim only when the tool itself redacted it", async () => {
    const runner = new ScriptedRunner({ omp: AUTHENTICATED.omp });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp[0],
      runner,
      now: NOW,
    });
    expect(evidence.subjectDisclosure).toBe("redacted");
    expect(evidence.subject).toBe("can…4f2");
    expect(evidence.proofDigest).toBeDefined();
  });

  it("falls back from an empty OMP account report to real loopback local inference", async () => {
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        invocations.push(invocation);
        if (invocation.command === "claude") return AUTHENTICATED.claude;
        if (invocation.command === "codex") return AUTHENTICATED.codex;
        if (invocation.args[0] === "usage") {
          return { exitCode: 0, stdout: JSON.stringify({ reports: [] }) };
        }
        return {
          exitCode: 0,
          stdout: `${WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER}\n`,
        };
      },
    };

    const report = await probeWorkspaceHostAgents({ runner, now: NOW });

    expect(report.allReady).toBe(true);
    expect(report.agents.omp).toMatchObject({
      ready: true,
      verificationKind: "local-inference",
      endpoint: "http://127.0.0.1:11434",
      proofDigest: workspaceHostAgentSubjectDigest(
        WORKSPACE_HOST_OMP_LOCAL_INFERENCE_MARKER,
      ),
    });
    expect(report.agents.omp?.subject).toBeUndefined();
    expect(invocations.filter((entry) => entry.command === "omp")).toHaveLength(
      2,
    );
    expect(
      invocations.find(
        (entry) => entry.command === "omp" && entry.args.includes("--model"),
      )?.args,
    ).toContain("--no-session");
    expect(
      invocations.find(
        (entry) => entry.command === "omp" && entry.args.includes("--model"),
      )?.args,
    ).toEqual(
      expect.arrayContaining(["--no-extensions", "--no-skills", "--no-rules"]),
    );
  });

  it("treats a non-zero exit as unauthenticated and records the status", async () => {
    const runner = new ScriptedRunner({
      claude: {
        exitCode: 1,
        stdout: "Not logged in. Run `claude auth login`.\n",
      },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });
    expect(evidence.ready).toBe(false);
    expect(evidence.exitStatus).toBe(1);
    expect(evidence.failure).toBe("non-zero-exit");
    expect(JSON.stringify(evidence)).not.toContain("claude auth login");
  });

  it("treats exit 0 with no parseable subject as a FAILED probe, not a nameless success", async () => {
    // A reworded or broken CLI is the realistic shape of this case; calling it authenticated is
    // how an unbacked boolean comes back.
    const runner = new ScriptedRunner({
      claude: { exitCode: 0, stdout: "OK\n" },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });
    expect(evidence.ready).toBe(false);
    expect(evidence.failure).toBe("no-verification-proof");
  });

  it("reduces a thrown probe error to a code, never surfacing the error text", async () => {
    const runner = new ScriptedRunner({
      claude: new Error(
        "spawn /opt/papercusp/current/bin/claude ENOENT --token=abc",
      ),
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });
    expect(evidence.ready).toBe(false);
    expect(evidence.failure).toBe("probe-error");
    expect(evidence.exitStatus).toBe(-1);
    expect(JSON.stringify(evidence)).not.toContain("ENOENT");
  });

  it("probes all three agents and reports allReady only when every one passed", async () => {
    const allGood = new ScriptedRunner({ ...AUTHENTICATED });
    const report = await probeWorkspaceHostAgents({
      runner: allGood,
      now: NOW,
    });
    expect(report.allReady).toBe(true);
    expect(Object.keys(report.agents).sort()).toEqual([
      "claude",
      "codex",
      "omp",
    ]);
    // Sequential, in the declared order — three CLIs racing one credential store is a source of
    // spurious failures.
    //
    // codex appears TWICE, and that is the WI-10001694 fix visible in the invocation log: its
    // account probe is `satisfiesReadiness: false`, so it can no longer break the loop and
    // live-inference now runs even when the account line matched. A single `codex` here would
    // mean the short-circuit is back.
    expect(allGood.invocations.map((i) => i.command)).toEqual([
      "claude",
      "codex",
      "codex",
      "omp",
    ]);

    const oneBad = new ScriptedRunner({
      ...AUTHENTICATED,
      codex: { exitCode: 1, stdout: "" },
    });
    const degraded = await probeWorkspaceHostAgents({
      runner: oneBad,
      now: NOW,
    });
    expect(degraded.allReady).toBe(false);
    expect(degraded.agents.codex?.ready).toBe(false);
    expect(degraded.agents.claude?.ready).toBe(true);
  });

  it("refuses a probe spec whose declared agent does not match its slot", async () => {
    await expect(
      probeWorkspaceHostAgents({
        runner: new ScriptedRunner({ ...AUTHENTICATED }),
        now: NOW,
        probes: {
          claude: [DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[0]],
        },
      }),
    ).rejects.toThrow(/declares agent 'codex'/);
  });

  it("passes a bounded timeout to the runner so a prompt cannot hang the step", async () => {
    const runner = new ScriptedRunner({ ...AUTHENTICATED });
    await probeWorkspaceHostAgents({ runner, now: NOW });
    for (const invocation of runner.invocations) {
      expect(invocation.timeoutMs).toBeGreaterThan(0);
      expect(Number.isFinite(invocation.timeoutMs)).toBe(true);
    }
  });

  it("uses a supplied probe environment as the complete child environment", async () => {
    const home = homedir();
    const outcome = await new NodeWorkspaceHostAgentProbeRunner().run({
      command: "/usr/bin/env",
      args: [],
      timeoutMs: 5_000,
      env: { HOME: home, USER: "workspace", PROBE_SENTINEL: "present" },
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("PROBE_SENTINEL=present");
    expect(outcome.stdout).toContain(`HOME=${home}`);
    expect(outcome.stdout).not.toContain("OPENAI_API_KEY=");
    expect(outcome.stdout).not.toContain("ANTHROPIC_API_KEY=");
    expect(outcome.stdout).not.toContain("PATH=");
  });

  it("starts a controller-side probe in its explicit isolated cwd", async () => {
    const outcome = await new NodeWorkspaceHostAgentProbeRunner().run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.cwd())"],
      timeoutMs: 5_000,
      cwd: tmpdir(),
      env: { HOME: tmpdir(), PATH: "/usr/bin:/bin" },
    });
    expect(outcome).toMatchObject({ exitCode: 0, stdout: tmpdir() });
    expect(() =>
      buildWorkspaceHostAgentProbeProcess({
        command: "codex",
        args: [],
        timeoutMs: 1_000,
        cwd: "relative/controller-home",
      }),
    ).toThrow(/cwd must be an absolute canonical path/);
  });

  it.each(["timeout", "output-limit"] as const)(
    "closes descendant output pipes when a probe reaches its %s",
    async (failure) => {
      let child: ChildProcess | undefined;
      let descendantPid: number | undefined;
      let closed: Promise<unknown> | undefined;
      const spawnProbe: typeof nodeSpawn = ((...args: Parameters<typeof nodeSpawn>) => {
        child = nodeSpawn(...args);
        closed = once(child, "close");
        child.stdout?.on("data", (chunk: Buffer) => {
          const match = /DESCENDANT_PID=(\d+)/.exec(chunk.toString());
          if (match) descendantPid = Number(match[1]);
        });
        return child;
      }) as typeof nodeSpawn;
      const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });",
        "console.log('DESCENDANT_PID=' + child.pid);",
        failure === "output-limit"
          ? "setTimeout(() => process.stdout.write('x'.repeat(1024 * 1024)), 50);"
          : "",
        "setTimeout(() => {}, 30000);",
      ].join("\n");
      try {
        await expect(
          new NodeWorkspaceHostAgentProbeRunner(spawnProbe).run({
            command: process.execPath,
            args: ["-e", script],
            timeoutMs: failure === "timeout" ? 2_000 : 10_000,
          }),
        ).rejects.toThrow(failure === "timeout" ? /timed out/ : /too much output/);
        expect(descendantPid).toBeGreaterThan(0);
        // `close`, unlike `exit`, waits for the descendant's inherited pipes too.
        expect(
          await Promise.race([closed!.then(() => true), delay(1_000, false)]),
        ).toBe(true);
      } finally {
        // Also clean up the intentionally red pre-fix reproduction.
        if (descendantPid) {
          try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ }
        }
        child?.kill("SIGKILL");
        await closed;
      }
    },
    15_000,
  );

  it("drops to the real workspace account through runuser and then scrubs the target environment", () => {
    const processInput = buildWorkspaceHostAgentProbeProcess({
      command: "claude",
      args: ["auth", "status"],
      timeoutMs: 5_000,
      runAsUser: "papercusp-workspace",
      env: {
        HOME: "/home/papercusp-workspace",
        USER: "papercusp-workspace",
        LOGNAME: "papercusp-workspace",
        PATH: "/opt/papercusp/current/bin:/usr/bin:/bin",
      },
    });
    expect(processInput).toEqual({
      command: "/usr/sbin/runuser",
      cwd: "/home/papercusp-workspace",
      args: [
        "--user",
        "papercusp-workspace",
        "--",
        "/usr/bin/env",
        "-i",
        "--",
        "HOME=/home/papercusp-workspace",
        "USER=papercusp-workspace",
        "LOGNAME=papercusp-workspace",
        "PATH=/opt/papercusp/current/bin:/usr/bin:/bin",
        "claude",
        "auth",
        "status",
      ],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    });
    expect(() =>
      buildWorkspaceHostAgentProbeProcess({
        command: "claude",
        args: [],
        timeoutMs: 5_000,
        runAsUser: "root",
        env: { PATH: "/usr/bin" },
      }),
    ).toThrow(/non-root Linux account/);
  });

  it("starts the agent in its home instead of the controller's inherited working directory", async () => {
    // Exercise the actual child cwd without requiring root for this unit suite.
    // The separate argv test covers runuser; only that privilege hop is removed.
    const withoutPrivilegeHop: typeof nodeSpawn = ((...input: Parameters<typeof nodeSpawn>) => {
      const [command, args, options] = input;
      expect(command).toBe("/usr/sbin/runuser");
      return nodeSpawn("/usr/bin/env", args.slice(4), options);
    }) as typeof nodeSpawn;
    const outcome = await new NodeWorkspaceHostAgentProbeRunner(withoutPrivilegeHop).run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.cwd())"],
      timeoutMs: 5_000,
      runAsUser: "papercusp-agent",
      env: { HOME: tmpdir(), USER: "papercusp-agent", PATH: "/usr/bin:/bin" },
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe(tmpdir());
  });

  it.each([undefined, "relative/home", "/home/agent\nother"])(
    "refuses an agent probe without a safe absolute home (%s)",
    (home) => {
      expect(() => buildWorkspaceHostAgentProbeProcess({
        command: "codex",
        args: [],
        timeoutMs: 1_000,
        runAsUser: "papercusp-agent",
        env: home === undefined ? {} : { HOME: home },
      })).toThrow(/absolute HOME/);
    },
  );

  it("gives the same account a stable digest and different accounts different digests", () => {
    expect(workspaceHostAgentSubjectDigest("a@b.c")).toBe(
      workspaceHostAgentSubjectDigest("a@b.c"),
    );
    expect(workspaceHostAgentSubjectDigest("a@b.c")).not.toBe(
      workspaceHostAgentSubjectDigest("d@e.f"),
    );
  });
});

describe("attested vendor runtime paths (D-259 Defect 2)", () => {
  const VENDOR = {
    claude: "/home/papercusp-agent/.local/bin/claude",
    codex: "/home/papercusp-agent/.papercusp/runtime/node_modules/.bin/codex",
    omp: "/home/papercusp-agent/.local/bin/omp",
  } satisfies Record<WorkspaceHostCanaryAgent, string>;

  it("execs the attested vendor path instead of the bare name the search path would resolve", async () => {
    // The script is keyed by COMMAND and deliberately holds NO entry for the bare names. A probe
    // that still shelled `claude` therefore rejects, rather than quietly passing against a fixture
    // that answered to both spellings — which is the shape that let this defect hide.
    const runner = new ScriptedRunner({
      [VENDOR.claude]: AUTHENTICATED.claude,
      [VENDOR.codex]: AUTHENTICATED.codex,
      [VENDOR.omp]: AUTHENTICATED.omp,
    });

    const report = await probeWorkspaceHostAgents({
      runner,
      now: NOW,
      runtimePaths: VENDOR,
    });

    expect(report.allReady).toBe(true);
    const commands = runner.invocations.map((invocation) => invocation.command);
    // codex twice: both of its specs run now that the account probe cannot end the loop
    // (WI-10001694). Both must exec the ATTESTED path — an evidence-only probe is still a probe,
    // and letting it fall back to the bare name would reintroduce D-259 Defect 2 through it.
    expect(commands).toEqual([
      VENDOR.claude,
      VENDOR.codex,
      VENDOR.codex,
      VENDOR.omp,
    ]);
    for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
      expect(commands).not.toContain(agent);
    }
  });

  it("substitutes the path into EVERY spec for an agent, not just the first", () => {
    // omp is the only agent with a fallback spec. Were the override applied per-agent-once rather
    // than per-spec, the hosted probe would exec the vendor binary while the local-inference
    // fallback dropped back to the wrapper — green on the happy path, wrong on the path that
    // actually runs when no hosted account answers.
    const specs = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp;
    expect(specs.length).toBeGreaterThan(1);
    for (const spec of specs) {
      expect(applyWorkspaceHostAgentRuntimePath(spec, VENDOR.omp).command).toBe(
        VENDOR.omp,
      );
    }
  });

  /**
   * D-265. `codex login status` is not a credential check: MEASURED 2026-09-03, it printed
   * `Logged in using ChatGPT` and exited 0 against an auth.json whose id_token was 30 days
   * expired and whose access and refresh tokens were both garbage. So codex readiness rests on
   * the live-inference probe, and the ONE property that makes that probe honest is its anchoring.
   *
   * codex ECHOES THE PROMPT, and the prompt necessarily contains the marker. So the marker is
   * present in the output of a FAILING run too — measured, once, in the `Reply with exactly …`
   * line of a run that died on `401 Unauthorized`. An unanchored pattern matches that echo and
   * reports every credential failure as ready, which is the precise inversion this file exists to
   * prevent. These are the positive and negative captures, reduced to their shapes.
   */
  it("does not accept codex's own prompt echo as proof of live inference", () => {
    const live = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex.find(
      (spec) => spec.verificationKind === "live-inference",
    );
    expect(live).toBeDefined();
    const marker = WORKSPACE_HOST_CODEX_LIVE_INFERENCE_MARKER;

    // The failing shape: the prompt echo, and the 401 that ended the run. No line is JUST the
    // marker, so a correctly anchored pattern finds nothing to capture.
    const failing = [
      "user",
      `Reply with exactly ${marker} and nothing else.`,
      "ERROR: Your access token could not be refreshed. Please log out and sign in again.",
    ].join("\n");
    expect(live?.proofPattern.test(failing)).toBe(false);

    // The passing shape: the same echo, PLUS the model's answer alone on its own line.
    const passing = [
      "user",
      `Reply with exactly ${marker} and nothing else.`,
      "codex",
      marker,
    ].join("\n");
    expect(live?.proofPattern.exec(passing)?.[1]).toBe(marker);
  });

  /**
   * Ordering is behavioural, not cosmetic: the probe loop breaks on the first READY spec, so the
   * account probe running first is what keeps the stronger "we know WHO this is" evidence for a
   * codex that can produce it, with live inference as the fallback rather than the default.
   */
  it("makes live-inference the ONLY probe that can mark codex ready, whatever the order", () => {
    const specs = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex;
    // WI-10001694, superseding D-265's ordering rationale. This asserts the READINESS SOURCE, not
    // the position, and that is the whole point: the defect was positional, so an order-blind
    // test passes on the broken arrangement and an order-ONLY test passes on a broken one that
    // merely kept its shape. Both dangerous arrangements — the forgeable probe first (it
    // short-circuits the real one) and second (it runs exactly when the real one did NOT pass) —
    // are refused by this assertion, because in neither can it be readiness-bearing.
    expect(
      specs
        .filter(workspaceHostAgentSpecSatisfiesReadiness)
        .map((spec) => spec.verificationKind),
    ).toEqual(["live-inference"]);
    // The account probe is still PRESENT: it is the only signal naming which account a host
    // authenticated as, and removing it was rejected as lossy. Kept, but inert for readiness.
    expect(specs.map((spec) => spec.verificationKind)).toContain(
      "authenticated-account",
    );

    // Selected by KIND, not index, so these argv rules cannot silently detach from the probe they
    // describe if the array is ever reordered — the failure this test exists to make impossible.
    const live = specs.find((spec) => spec.verificationKind === "live-inference");
    // No `-c` override in the argv: a model-specific value goes stale under the probe and fails
    // it for a non-credential reason (measured: HTTP 400 on `model_reasoning_effort=minimal`).
    expect(live?.args).not.toContain("-c");
    // A readiness probe must not need write access to the host it is judging.
    expect(live?.args).toContain("read-only");
  });

  it("does NOT mark codex ready from a forged account line when live inference fails", async () => {
    // The vacuity itself, end to end. MEASURED 2026-09-17: a fabricated `$CODEX_HOME/auth.json`
    // makes `codex login status` print output byte-identical to the real credential's. This
    // fixture is that forgery — an account line SUBJECT_PATTERN matches, and NO live-inference
    // marker, because the fabricated token cannot actually reach the endpoint.
    //
    // Before WI-10001694 this returned ready:true: the account probe matched, the loop broke on
    // the first ready spec, and live-inference never ran.
    const forged = new ScriptedRunner({
      ...AUTHENTICATED,
      codex: {
        exitCode: 0,
        stdout: "Login status: signed in as attacker@example.invalid (Team)\n",
      },
    });
    const report = await probeWorkspaceHostAgents({ runner: forged, now: NOW });

    expect(report.agents.codex?.ready).toBe(false);
    expect(report.allReady).toBe(false);
    // It must fail as the INFERENCE probe, not the account one — proof that live-inference
    // actually ran rather than being short-circuited into never executing.
    expect(report.agents.codex?.verificationKind).toBe("live-inference");
    // The forged subject is still recorded, and recorded as SELF-REPORTED. This is the half that
    // makes keeping the probe safe: identity survives for diagnosis without ever implying it was
    // verified, and it must never land in `subject` (publishable) or set `ready`.
    expect(report.agents.codex?.selfReportedSubjectDigest).toBe(
      workspaceHostAgentSubjectDigest("attacker@example.invalid"),
    );
    expect(report.agents.codex?.subject).toBeUndefined();
  });

  it("records the account subject as self-reported even on a codex that IS ready", () => {
    // The digest must never be confused with proof. On a ready codex the readiness came from the
    // marker, so `proofDigest` digests the MARKER while the account lands in the self-reported
    // field — two different values, which is what stops a reader treating one as the other.
    const specs = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex;
    const account = specs.find(
      (spec) => spec.verificationKind === "authenticated-account",
    );
    expect(account).toBeDefined();
    expect(workspaceHostAgentSpecSatisfiesReadiness(account!)).toBe(false);
  });

  it("refuses a probe set in which nothing can establish readiness", async () => {
    // The structural guard. Opting the last readiness-bearing probe out is a silent failure in the
    // direction that reads as a credential fault, so the SET is refused rather than the agent
    // being reported permanently not-ready for a reason no one can see.
    const account = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex.find(
      (spec) => spec.verificationKind === "authenticated-account",
    );
    await expect(
      probeWorkspaceHostAgents({
        runner: new ScriptedRunner({ ...AUTHENTICATED }),
        now: NOW,
        probes: { codex: [account!] },
      }),
    ).rejects.toThrow(/no readiness-bearing verification probe/);
  });

  it("changes only the command, leaving the proof rules that make evidence falsifiable intact", () => {
    const spec = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0];
    const resolved = applyWorkspaceHostAgentRuntimePath(spec, VENDOR.claude);
    expect(resolved).toEqual({ ...spec, command: VENDOR.claude });
    expect(resolved.proofPattern).toBe(spec.proofPattern);
    expect(resolved.verificationKind).toBe(spec.verificationKind);
    expect(resolved.endpoint).toBe(spec.endpoint);
  });

  it("falls back to the spec's own command when an agent has no attested path, and still FAILS honestly", async () => {
    // A host provisioned before the vendor installs existed has no attested path for codex. The
    // required behaviour is a probe that RUNS AND FAILS, not a throw: a throw would re-file "this
    // host cannot authenticate codex" — the canary's whole finding — as an infrastructure error.
    const runner = new ScriptedRunner({
      [VENDOR.claude]: AUTHENTICATED.claude,
      codex: { exitCode: 127, stdout: "" },
      [VENDOR.omp]: AUTHENTICATED.omp,
    });

    const report = await probeWorkspaceHostAgents({
      runner,
      now: NOW,
      runtimePaths: { claude: VENDOR.claude, omp: VENDOR.omp },
    });

    // codex appears TWICE: the account probe and the D-265 live-inference probe are two specs
    // for one agent, and the loop breaks only on a READY one — so an unattested codex falls back
    // to the bare name for both, and both fail. That is the honest outcome being asserted here.
    expect(runner.invocations.map((invocation) => invocation.command)).toEqual([
      VENDOR.claude,
      "codex",
      "codex",
      VENDOR.omp,
    ]);
    expect(report.agents.codex?.ready).toBe(false);
    expect(report.agents.codex?.failure).toBe("non-zero-exit");
    expect(report.allReady).toBe(false);
  });

  it("refuses a relative path, an empty path, or one carrying a control character", () => {
    const spec = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0];
    for (const bad of [
      "claude",
      "",
      "/",
      "./bin/claude",
      `/usr/bin/claude${String.fromCharCode(0)}/etc/passwd`,
      `/usr/bin/claude${String.fromCharCode(10)}/usr/bin/whoami`,
    ]) {
      expect(() => applyWorkspaceHostAgentRuntimePath(spec, bad)).toThrow(
        /absolute path free of control characters/,
      );
    }
  });

  it("leaves the spec untouched when no path is attested for that agent", () => {
    const spec = DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0];
    expect(applyWorkspaceHostAgentRuntimePath(spec, undefined)).toBe(spec);
  });
});

/**
 * WI-2144034. A metered provider that has run out of quota fails a probe in a way that, from
 * evidence alone, is indistinguishable from a broken credential — and the line that explains it
 * goes to the stream this module deliberately discards. Measured 2026-09-04: `codex exec` printed
 * `You've hit your usage limit` on STDERR and exited 0, so the probe recorded
 * `no-verification-proof` and two GCP canaries were spent looking at credentials that were fine.
 */
describe("provider-cause classification (WI-2144034)", () => {
  const QUOTA_STDERR =
    "ERROR: You've hit your usage limit. Visit https://example.invalid/usage to purchase more credits or try again at Sep 6th, 2026 10:26 PM.\n";

  it("classifies the measured quota phrasings and nothing else", () => {
    for (const text of [
      QUOTA_STDERR,
      "You've hit your weekly limit · resets Sep 24, 7am (America/New_York)",
      // Measured 2026-10-07 (WI-10007043): claude 2.1.289's 5-hour window, on stdout with exit 1.
      "You've hit your session limit · resets 11pm (America/New_York)",
      "usage limit reached for this account",
      "Quota exceeded for model",
      "error code: insufficient_quota",
      "Rate limit exceeded, retry later",
    ]) {
      expect(classifyWorkspaceHostAgentProbeFailure(text)).toBe(
        "provider-usage-limit",
      );
    }
  });

  /**
   * CALIBRATION CONTROL, and the reason the test above proves anything: a classifier that simply
   * returned "provider-usage-limit" for every input would pass it. These are the failures that
   * must stay UNCLASSIFIED, because mislabelling a credential fault as a billing problem sends
   * the reader to the wrong page — the more expensive of the two errors.
   */
  it("leaves genuine credential and transport failures unclassified", () => {
    for (const text of [
      "Not logged in. Run `codex login` to authenticate.",
      // A credential fault WITHOUT the provider's explicit 401 status stays unclassified: the
      // classifier names a refusal only when the provider says so (see the test below).
      "Incorrect API key provided: sk-live-…",
      "403 Forbidden: invalid api key",
      "error: connection refused",
      "The weekly limit setting is unavailable",
      "Session limit settings are unavailable",
      "Logged in using ChatGPT",
      "",
    ]) {
      expect(classifyWorkspaceHostAgentProbeFailure(text)).toBeUndefined();
    }
  });

  /**
   * RECURRENCE GUARD for the P-305 G6 root cause (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22
   * D-320): a delivered auth.json that dropped `refresh_token` made codex-cli's serde reader exit 1
   * with `missing field`, and the probe recorded a bare `non-zero-exit` that pointed every reader at
   * the account instead of the projection. These two reasons were pinned by NO test when they landed
   * (WI-10001023, found by the independent D-319 verification) — a regression back to `non-zero-exit`
   * would have failed nothing. Each reason is asserted twice: at the classifier and through a real
   * child whose stderr carries the measured text, so neither the pattern nor the probe plumbing can
   * silently lose it.
   */
  describe("malformed and refused credentials (P-305 D-320 recurrence guard)", () => {
    it("names a credential file the CLI cannot deserialize as credential-malformed", () => {
      // Measured codex-cli 0.153.4 / 0.154.0 output, verbatim shape (WI-10001017 contrastive arm h2).
      expect(
        classifyWorkspaceHostAgentProbeFailure(
          "Error checking login status: missing field `refresh_token` at line 1 column 238",
        ),
      ).toBe("credential-malformed");
      expect(classifyWorkspaceHostAgentProbeFailure("missing field `id_token`")).toBe(
        "credential-malformed",
      );
    });

    it("names an explicit provider 401 as credential-unauthorized", () => {
      expect(classifyWorkspaceHostAgentProbeFailure("401 Unauthorized: invalid api key")).toBe(
        "credential-unauthorized",
      );
      expect(classifyWorkspaceHostAgentProbeFailure("HTTP 401 Unauthorized")).toBe(
        "credential-unauthorized",
      );
    });

    it("keeps the two reasons distinct from each other and from quota", () => {
      expect(classifyWorkspaceHostAgentProbeFailure("missing field `refresh_token`")).not.toBe(
        "credential-unauthorized",
      );
      expect(classifyWorkspaceHostAgentProbeFailure("401 Unauthorized")).not.toBe(
        "credential-malformed",
      );
      expect(classifyWorkspaceHostAgentProbeFailure("401 Unauthorized")).not.toBe(
        "provider-usage-limit",
      );
    });

    for (const [reason, stderrText] of [
      [
        "credential-malformed",
        "Error checking login status: missing field `refresh_token` at line 1 column 238",
      ],
      ["credential-unauthorized", "401 Unauthorized: invalid api key"],
    ] as const) {
      it(`reports ${reason} — not non-zero-exit — from a real child's stderr without publishing its text`, async () => {
        const evidence = await probeWorkspaceHostAgentVerification({
          spec: {
            ...DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[1],
            command: "/bin/sh",
            args: ["-c", `printf '%s' '${stderrText}' >&2; exit 1`],
          },
          runner: new NodeWorkspaceHostAgentProbeRunner(),
          now: NOW,
        });
        expect(evidence).toMatchObject({ ready: false, exitStatus: 1, failure: reason });
        expect(evidence.failure).not.toBe("non-zero-exit");
        expect(JSON.stringify(evidence)).not.toContain("refresh_token");
        expect(JSON.stringify(evidence)).not.toContain("invalid api key");
      });
    }
  });

  it("classifies revoked refresh credentials from a real child's stderr without publishing its text", async () => {
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: {
        ...DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[1],
        command: "/bin/sh",
        args: ["-c", "printf '%s' 'ERROR: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.' >&2; exit 1"],
      },
      runner: new NodeWorkspaceHostAgentProbeRunner(),
      now: NOW,
    });
    expect(evidence).toMatchObject({ ready: false, exitStatus: 1, failure: "credential-revoked" });
    expect(JSON.stringify(evidence)).not.toContain("refresh token");
    expect(classifyWorkspaceHostAgentProbeFailure("A token may be revoked by its owner")).toBeUndefined();
  });

  it("reports the measured shape — exit 0, no marker, quota named — as provider-usage-limit", async () => {
    const runner = new ScriptedRunner({
      codex: {
        exitCode: 0,
        stdout: "Reply with exactly P046_CODEX_LIVE_OK and nothing else.\n",
        failureHint: "provider-usage-limit",
      },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[1],
      runner,
      now: NOW,
    });

    expect(evidence.ready).toBe(false);
    expect(evidence.failure).toBe("provider-usage-limit");
  });

  /**
   * PERMANENT CONTROL for the case above. The subject is an imported module, so a copy-out
   * mutation cannot reach it; this pins the UNFIXED behaviour instead. Byte-identical to the test
   * above except for the absent hint — so if `probeWorkspaceHostAgentVerification` ever ignored
   * `failureHint` and hard-coded the generic code, the pair above would fail while this one still
   * passed, and if it ever reported the provider code unconditionally, THIS one fails.
   */
  it("still reports no-verification-proof when nothing was classified", async () => {
    const runner = new ScriptedRunner({
      codex: {
        exitCode: 0,
        stdout: "Reply with exactly P046_CODEX_LIVE_OK and nothing else.\n",
      },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[1],
      runner,
      now: NOW,
    });

    expect(evidence.ready).toBe(false);
    expect(evidence.failure).toBe("no-verification-proof");
  });

  it("prefers the classified cause over the generic non-zero-exit code", async () => {
    const runner = new ScriptedRunner({
      claude: { exitCode: 1, stdout: "", failureHint: "provider-usage-limit" },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
      runner,
      now: NOW,
    });
    expect(evidence.failure).toBe("provider-usage-limit");

    const unclassified = new ScriptedRunner({
      claude: { exitCode: 1, stdout: "" },
    });
    expect(
      (
        await probeWorkspaceHostAgentVerification({
          spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
          runner: unclassified,
          now: NOW,
        })
      ).failure,
    ).toBe("non-zero-exit");
  });

  it("keeps the provider's text out of evidence entirely", async () => {
    const runner = new ScriptedRunner({
      codex: {
        exitCode: 0,
        stdout: "",
        failureHint: "provider-usage-limit",
      },
    });
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.codex[1],
      runner,
      now: NOW,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("usage limit");
    expect(serialized).not.toContain("purchase more credits");
    expect(serialized).not.toContain("example.invalid");
  });

  /**
   * The load-bearing one: it exercises the REAL runner against the REAL stream. stderr is drained
   * and never returned, so this is what proves the cause survives that discard as a code.
   */
  it("classifies a real child's STDERR while returning none of its text", async () => {
    const outcome = await new NodeWorkspaceHostAgentProbeRunner().run({
      command: "/bin/sh",
      args: ["-c", `printf '%s' "${QUOTA_STDERR.trim()}" >&2; exit 0`],
      timeoutMs: 10_000,
    });

    // Exit 0 with no marker: exactly the shape that used to read as a credential fault.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.failureHint).toBe("provider-usage-limit");
    expect(outcome.stdout).toBe("");
    expect(JSON.stringify(outcome)).not.toContain("usage limit");
  });

  it("preserves Claude weekly quota from a real child without asserting readiness", async () => {
    const message = "You've hit your weekly limit · resets Sep 24, 7am (America/New_York)";
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: {
        ...DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.claude[0],
        command: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(message)}); process.exit(1)`],
      },
      runner: new NodeWorkspaceHostAgentProbeRunner(),
      now: NOW,
    });
    expect(evidence).toMatchObject({
      ready: false,
      exitStatus: 1,
      failure: "provider-usage-limit",
    });
    expect(evidence.proofDigest).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toContain(message);
  });

  it("leaves failureHint absent for a real child whose stderr says nothing recognizable", async () => {
    const outcome = await new NodeWorkspaceHostAgentProbeRunner().run({
      command: "/bin/sh",
      args: ["-c", "printf 'not logged in' >&2; exit 1"],
      timeoutMs: 10_000,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.failureHint).toBeUndefined();
  });

  it("publishes only a capped stderr byte count for an unclassified OMP failure", async () => {
    const privateKeyText = [
      ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "),
      "synthetic-test-key-material",
      ["-----END RSA", "PRIVATE KEY-----"].join(" "),
    ].join("\n");
    const childScript =
      "process.stderr.write(" +
      JSON.stringify(privateKeyText) +
      " + 'x'.repeat(70 * 1024), () => process.exit(1));";
    const evidence = await probeWorkspaceHostAgentVerification({
      spec: {
        ...DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_PROBES.omp[0],
        command: process.execPath,
        args: ["-e", childScript],
      },
      runner: new NodeWorkspaceHostAgentProbeRunner(),
      now: NOW,
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence).toMatchObject({
      ready: false,
      exitStatus: 1,
      failure: "non-zero-exit",
      stderrByteCount: 64 * 1024,
      stderrByteCountTruncated: true,
    });
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("not-a-real-key");
  });
});

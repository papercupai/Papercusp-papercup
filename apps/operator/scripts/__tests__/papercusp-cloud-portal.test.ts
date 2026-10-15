import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { assertTutorialAssistanceEnvironment, assertTutorialVoiceEnvironment, hostedServiceProcessIds, parseEnvFile, resolveIntegrationReferences, siblingAppEnv } from "../systemd/portal-hosted-launcher";

const ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(ROOT, "apps/operator/scripts/systemd/deploy-cloud-portal.sh");
const TEMPLATE = join(ROOT, "apps/operator/scripts/systemd/papercusp-cloud-portal.service.in");
const PROXY_SCRIPT = join(ROOT, "apps/operator/scripts/systemd/papercusp-cloud-portal-proxy.mjs");
const LAUNCHER_SCRIPT = join(ROOT, "apps/operator/scripts/systemd/portal-hosted-launcher.ts");
const README = join(ROOT, "apps/operator/scripts/systemd/README.md");

describe("hosted service evidence process inventory", () => {
  const dirs: Record<string, string[]> = {
    "/proc/10/task": ["10", "11"],
    "/proc/20/task": ["20"],
    "/proc/30/task": ["30"],
  };
  const children: Record<string, string> = {
    "/proc/10/task/10/children": "",
    "/proc/10/task/11/children": "20 20",
    "/proc/20/task/20/children": "30",
    "/proc/30/task/30/children": "10",
  };
  it("reaches the secret-holding grandchild through worker threads and deduplicates cycles", () => {
    const pids = hostedServiceProcessIds(10, { readDir: path => dirs[path], readFile: path => children[path] });
    const secretHoldingPid = 30;
    expect(pids).toEqual([10, 20, secretHoldingPid]);
    expect(pids.slice(0, 2)).not.toContain(secretHoldingPid); // previous one-level inventory misses it
  });
  it("refuses a bounded partial inventory rather than claiming secret coverage", () => {
    expect(() => hostedServiceProcessIds(10, {
      readDir: path => dirs[path], readFile: path => children[path], maxProcesses: 2,
    })).toThrow("hosted_process_tree_incomplete");
  });
  it("refuses an unreadable root but tolerates a child exiting during traversal", () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(() => hostedServiceProcessIds(10, { readDir: () => { throw missing; } })).toThrow("gone");
    expect(hostedServiceProcessIds(10, {
      readDir: path => { if (path === "/proc/20/task") throw missing; return dirs[path]; },
      readFile: path => children[path],
    })).toEqual([10, 20]);
  });
});

interface Fixture {
  dir: string;
  portalRoot: string;
  runtimeRoot: string;
  unitDir: string;
  binDir: string;
  logPath: string;
  analyzeLogPath: string;
  procRoot: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "papercusp-cloud-portal-"));
  const portalRoot = join(dir, "portal app");
  const runtimeRoot = join(dir, ".portal-runtime", "portal app");
  const nextDir = join(portalRoot, "node_modules", ".bin");
  const releaseDir = join(runtimeRoot, "releases", "build-one");
  const currentDir = runtimeRoot;
  const unitDir = join(dir, "systemd", "user");
  const tempDir = join(dir, "tmp");
  const binDir = join(dir, "bin");
  const procRoot = join(dir, "proc");
  mkdirSync(join(portalRoot, "scripts"), { recursive: true });
  mkdirSync(nextDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  symlinkSync(join("releases", "build-one"), join(currentDir, "current"), "dir");
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(procRoot, "4242"), { recursive: true });
  mkdirSync(join(procRoot, "4242", "task", "4242"), { recursive: true });
  mkdirSync(join(procRoot, "4343"), { recursive: true });
  writeFileSync(join(dir, "hosted.env"), "PAPERCUSP_HOSTED_PUBLIC_ORIGIN=https://example.test\n");
  writeFileSync(join(dir, "operator.env"), "DATABASE_URL=postgres://fixture\n");
  writeFileSync(join(portalRoot, "package.json"), '{"name":"portal-fixture"}\n');
  writeFileSync(join(nextDir, "next"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(nextDir, "next"), 0o755);
  // deploy-cloud-portal.sh proves `current` was built from $PORTAL_ROOT by reading the
  // `join(root, "<checkout-relative server.js>")` a real standalone entry embeds and
  // refuses the handoff otherwise (EI-22123385977067109) — so the fixture's entry must
  // name this fixture's own portal root, not be an empty module.
  writeFileSync(
    join(releaseDir, "standalone-entry.mjs"),
    `import { join } from "node:path";\nconst root = "/";\nexport default join(root, ${JSON.stringify(
      `${portalRoot.replace(/^\//, "")}/server.js`,
    )});\n`,
  );
  writeFileSync(join(portalRoot, "scripts", "start-web.mjs"), "export {};\n");
  writeFileSync(join(procRoot, "4242", "cmdline"), Buffer.from("node\0old-next-dev\0"));
  // `/proc/<pid>/task/<pid>/children` is newline-free on Linux. The handoff
  // verifier must still consume its final record rather than treating the
  // managed generation as stale and rolling a healthy service back.
  writeFileSync(join(procRoot, "4242", "task", "4242", "children"), "4343");
  symlinkSync(releaseDir, join(procRoot, "4343", "cwd"), "dir");
  return {
    dir,
    portalRoot,
    runtimeRoot,
    unitDir,
    binDir,
    logPath: join(dir, "systemctl.log"),
    analyzeLogPath: join(dir, "systemd-analyze.log"),
    procRoot,
  };
}

function envFor(files: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAPERCUSP_CLOUD_PORTAL_ROOT: files.portalRoot,
    PAPERCUSP_CLOUD_PORTAL_NODE: process.execPath,
    PAPERCUSP_CLOUD_PORTAL_UNIT_DIR: files.unitDir,
    PAPERCUSP_CLOUD_PORTAL_TMPDIR: join(files.dir, "tmp"),
    PAPERCUSP_CLOUD_PORTAL_HEALTH_WAIT_SEC: "0",
    PAPERCUSP_CLOUD_PORTAL_SYSTEMD_ANALYZE: "/bin/true",
    PAPERCUSP_CLOUD_PORTAL_PROC_ROOT: files.procRoot,
    PAPERCUSP_CLOUD_PORTAL_PROXY_INSTALL: join(files.binDir, "papercusp-cloud-portal-proxy.mjs"),
    PAPERCUSP_CLOUD_PORTAL_LAUNCHER_INSTALL: join(files.binDir, "papercusp-cloud-portal-launcher.ts"),
    PAPERCUSP_CLOUD_PORTAL_HOSTED_ENV_FILE: join(files.dir, "hosted.env"),
    PAPERCUSP_CLOUD_PORTAL_OPERATOR_ENV_FILE: join(files.dir, "operator.env"),
    PAPERCUSP_CLOUD_PORTAL_INTEGRATION_ROOT: ROOT,
    PAPERCUSP_CLOUD_PORTAL_TSX: process.execPath,
  };
}

function gitCommitAll(portalRoot: string, message: string) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  spawnSync("git", ["init", "-q"], { cwd: portalRoot, env });
  spawnSync("git", ["add", "-A"], { cwd: portalRoot, env });
  spawnSync("git", ["commit", "-q", "-m", message, "--allow-empty"], { cwd: portalRoot, env });
}

function writeReleaseManifest(runtimeRoot: string, publishedAt: string, sourceRootDigest?: string) {
  writeFileSync(
    join(runtimeRoot, "current", ".papercusp-release.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        buildId: "build-one",
        release: "build-one",
        sourceRoot: "/x",
        publishedAt,
        ...(sourceRootDigest ? { sourceRootDigest } : {}),
      },
      null,
      2,
    ) + "\n",
  );
}

// Stands in for the portal checkout's scripts/release-source-digest.mjs: the deploy
// script runs `$NODE_BIN <portalRoot>/scripts/release-source-digest.mjs <portalRoot>`
// and reads one hex line from stdout.
function writeDigestCli(portalRoot: string, digest: string) {
  writeFileSync(
    join(portalRoot, "scripts", "release-source-digest.mjs"),
    `process.stdout.write(${JSON.stringify(`${digest}\n`)});\n`,
  );
}

const RELEASE_DIGEST = "c0ffee".repeat(10) + "abcd";

describe("hosted Portal boot launcher", () => {
  it("runs when invoked with the installed launcher basename", () => {
    const dir = mkdtempSync(join(tmpdir(), "papercusp-cloud-portal-launcher-cli-"));
    try {
      const installedLauncher = join(dir, "papercusp-cloud-portal-launcher.ts");
      writeFileSync(installedLauncher, readFileSync(LAUNCHER_SCRIPT, "utf8"));
      const result = spawnSync(join(ROOT, "node_modules/.bin/tsx"), [installedLauncher], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PAPERCUSP_PORTAL_ROOT: "",
          PAPERCUSP_PORTAL_START_WEB: "",
          PAPERCUSP_PORTAL_HOSTED_ENV_FILE: "",
          PAPERCUSP_INTEGRATION_ROOT: "",
        },
      });

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("portal_hosted_launcher_configuration_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("configures the launcher's own secret reader before importing it, not only the Portal child", () => {
    const dir = mkdtempSync(join(tmpdir(), "papercusp-cloud-portal-parent-secrets-"));
    try {
      const installedLauncher = join(dir, "papercusp-cloud-portal-launcher.ts");
      const hostedEnv = join(dir, "hosted.env");
      const operatorEnv = join(dir, "operator.env");
      const startWeb = join(dir, "start-web.mjs");
      const resolverDir = join(dir, "packages/operator-core/lib/auth/hosted");
      const adminUrl = "postgresql://portal_fixture@127.0.0.1/portal_fixture";
      mkdirSync(resolverDir, { recursive: true });
      writeFileSync(installedLauncher, readFileSync(LAUNCHER_SCRIPT, "utf8"));
      writeFileSync(hostedEnv, "SESSION_REF=integration:TEST_SESSION_COOKIE_SECRET\n");
      writeFileSync(operatorEnv, `HARNESS_ADMIN_DATABASE_URL=${adminUrl}\n`);
      writeFileSync(join(resolverDir, "secret-ref.ts"), `
        const parentAdminUrlAtImport = process.env.HARNESS_ADMIN_DATABASE_URL;
        export async function resolveHostedSecretRef(reference: string) {
          if (parentAdminUrlAtImport !== ${JSON.stringify(adminUrl)}) throw new Error('wrong_parent_credential_store');
          if (reference !== 'integration:TEST_SESSION_COOKIE_SECRET') throw new Error('wrong_secret_reference');
          return 'SESSION_SENTINEL';
        }
      `);
      writeFileSync(startWeb, `
        if (process.env.HARNESS_ADMIN_DATABASE_URL !== ${JSON.stringify(adminUrl)}) throw new Error('wrong_child_credential_store');
        if (process.env.SESSION_REF !== 'env:PAPERCUSP_CLOUD_PORTAL_SECRET_TEST_SESSION_COOKIE_SECRET') throw new Error('unresolved_child_reference');
        if (process.env.PAPERCUSP_CLOUD_PORTAL_SECRET_TEST_SESSION_COOKIE_SECRET !== 'SESSION_SENTINEL') throw new Error('missing_child_secret');
        process.stdout.write('hosted_child_started');
      `);
      const env = { ...process.env };
      delete env.HARNESS_ADMIN_DATABASE_URL;
      delete env.DATABASE_URL;
      const result = spawnSync(join(ROOT, "node_modules/.bin/tsx"), [installedLauncher], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...env,
          PAPERCUSP_PORTAL_ROOT: dir,
          PAPERCUSP_PORTAL_START_WEB: startWeb,
          PAPERCUSP_PORTAL_HOSTED_ENV_FILE: hostedEnv,
          PAPERCUSP_PORTAL_OPERATOR_ENV_FILE: operatorEnv,
          PAPERCUSP_INTEGRATION_ROOT: dir,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("hosted_child_started");
      expect(result.stdout + result.stderr).not.toContain("SESSION_SENTINEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly before importing the secret reader when no admin database URL is configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "papercusp-cloud-portal-missing-admin-"));
    try {
      const installedLauncher = join(dir, "papercusp-cloud-portal-launcher.ts");
      const hostedEnv = join(dir, "hosted.env");
      const operatorEnv = join(dir, "operator.env");
      writeFileSync(installedLauncher, readFileSync(LAUNCHER_SCRIPT, "utf8"));
      writeFileSync(hostedEnv, "SESSION_REF=integration:TEST_SESSION_COOKIE_SECRET\n");
      writeFileSync(operatorEnv, "");
      const env = { ...process.env };
      delete env.HARNESS_ADMIN_DATABASE_URL;
      delete env.DATABASE_URL;
      const result = spawnSync(join(ROOT, "node_modules/.bin/tsx"), [installedLauncher], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...env,
          PAPERCUSP_PORTAL_ROOT: dir,
          PAPERCUSP_PORTAL_START_WEB: join(dir, "start-web.mjs"),
          PAPERCUSP_PORTAL_HOSTED_ENV_FILE: hostedEnv,
          PAPERCUSP_PORTAL_OPERATOR_ENV_FILE: operatorEnv,
          PAPERCUSP_INTEGRATION_ROOT: dir,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal_hosted_admin_database_url_missing");
      expect(result.stderr).not.toContain("Cannot find module");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites encrypted integration references to ephemeral env references", async () => {
    const source = parseEnvFile("# comment\nWORKOS_API_KEY_REF=integration:WORKOS_API_KEY\nWORKOS_CLIENT_ID=client_test\n");
    const rewritten = await resolveIntegrationReferences(source, async (reference) => {
      expect(reference).toBe("integration:WORKOS_API_KEY");
      return "SECRET_SENTINEL";
    });
    expect(rewritten.WORKOS_API_KEY_REF).toBe("env:PAPERCUSP_CLOUD_PORTAL_SECRET_WORKOS_API_KEY");
    expect(rewritten.PAPERCUSP_CLOUD_PORTAL_SECRET_WORKOS_API_KEY).toBe("SECRET_SENTINEL");
    expect(rewritten.WORKOS_CLIENT_ID).toBe("client_test");
  });

  it("rejects malformed encrypted references before child startup", async () => {
    await expect(resolveIntegrationReferences({ BAD_REF: "integration:not-valid" }, async () => "never"))
      .rejects.toThrow("portal_hosted_secret_ref_malformed");
  });

  it("refuses incomplete tutorial voice setup before contacting the provider", async () => {
    const provider = vi.fn();
    await expect(assertTutorialVoiceEnvironment({}, provider)).rejects.toThrow("tutorial_voice_configuration_missing");
    await expect(assertTutorialVoiceEnvironment({ PORTAL_ELEVENLABS_API_KEY: "test-key",
      PORTAL_ELEVENLABS_AGENT_ID: "test-agent" }, provider)).rejects.toThrow("tutorial_voice_prompt_override_required");
    expect(provider).not.toHaveBeenCalled();
  });

  it("verifies actual provider prompt capability rather than trusting the local flag", async () => {
    const env = { PORTAL_ELEVENLABS_API_KEY: "test-key", PORTAL_ELEVENLABS_AGENT_ID: "test-agent",
      PORTAL_ELEVENLABS_PROMPT_OVERRIDE: "1" };
    const provider = vi.fn(async () => Response.json({ platform_settings: { overrides: {
      conversation_config_override: { agent: { prompt: { prompt: false } } },
    } } }));
    await expect(assertTutorialVoiceEnvironment(env, provider)).rejects.toThrow("tutorial_voice_prompt_override_required");
    provider.mockResolvedValueOnce(Response.json({ platform_settings: { overrides: {
      conversation_config_override: { agent: { prompt: { prompt: true } } },
    } } }));
    await expect(assertTutorialVoiceEnvironment(env, provider)).resolves.toBeUndefined();
    expect(provider).toHaveBeenLastCalledWith("https://api.elevenlabs.io/v1/convai/agents/test-agent",
      expect.objectContaining({ headers: { "xi-api-key": "test-key" }, signal: expect.any(AbortSignal) }));
  });

  it("keeps provider refusal details out of tutorial preflight errors", async () => {
    const provider = vi.fn(async () => Response.json({ secret: "provider-sentinel" }, { status: 403 }));
    await expect(assertTutorialVoiceEnvironment({ PORTAL_ELEVENLABS_API_KEY: "test-key",
      PORTAL_ELEVENLABS_AGENT_ID: "test-agent", PORTAL_ELEVENLABS_PROMPT_OVERRIDE: "1" }, provider))
      .rejects.toThrow(/^tutorial_voice_provider_refused$/);
  });

  it("preflights Help without identity, conversation or owner authority and consumes the completed SSE answer", async () => {
    const provider = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of ['event: delta\ndata: {"text":"hi"}\n\nevent: do', 'ne\ndata: {"answer":"Your provider bills infrastructure."}\n\n']) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    await expect(assertTutorialAssistanceEnvironment({ PORTAL_TUTORIAL_SERVED_E2E: "1",
      PORTAL_OPERATOR_ORIGIN: "http://127.0.0.1:1234" }, provider)).resolves.toBeUndefined();
    const [url, request] = provider.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("http://127.0.0.1:1234/api/agent-mcp/operator-converse");
    expect(JSON.parse(request.body as string)).toEqual({
      messages: [{ role: "user", content: "Explain who bills infrastructure in this lesson." }],
      trigger: "user_message", modality: "text", hostTrust: "public",
      lessonContext: { version: 3, step: "billing", status: "ready" },
    });
    expect(request.headers).toEqual({ "content-type": "application/json" });
    expect(request.signal?.aborted).toBe(true);
  });

  it("rejects HTTP success with backend errors, an empty answer or an unfinished stream", async () => {
    for (const body of ['event: error\ndata: {"message":"private-backend-sentinel"}\n\n',
      'event: done\ndata: {"answer":" "}\n\n', 'event: delta\ndata: {"text":"partial"}\n\n',
      'event: done\ndata: invalid-json\n\n']) {
      const provider = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
      await expect(assertTutorialAssistanceEnvironment({ PORTAL_TUTORIAL_SERVED_E2E: "1",
        PORTAL_OPERATOR_ORIGIN: "http://localhost:1234" }, provider))
        .rejects.toThrow(/^tutorial_help_provider_unavailable$/);
    }
    for (const response of [Response.json({ error: "private-sentinel" }, { status: 503 }), Response.json({ answer: "ok" })]) {
      await expect(assertTutorialAssistanceEnvironment({ PORTAL_TUTORIAL_SERVED_E2E: "1",
        PORTAL_OPERATOR_ORIGIN: "http://localhost:1234" }, async () => response))
        .rejects.toThrow(/^tutorial_help_provider_unavailable$/);
    }
  });

  it("requires an explicit local operator before Help and stops incomplete voice setup before any provider call", async () => {
    const provider = vi.fn();
    for (const origin of [undefined, "https://example.test", "http://user:secret@localhost:1234", "http://localhost:1234/private"]) {
      await expect(assertTutorialAssistanceEnvironment({ PORTAL_TUTORIAL_SERVED_E2E: "1", PORTAL_OPERATOR_ORIGIN: origin }, provider))
        .rejects.toThrow("tutorial_help_operator_origin_required");
    }
    await expect(assertTutorialAssistanceEnvironment({ PORTAL_TUTORIAL_SERVED_E2E: "1",
      PORTAL_TUTORIAL_VOICE_SERVED_E2E: "1", PORTAL_OPERATOR_ORIGIN: "http://localhost:1234" }, provider))
      .rejects.toThrow("tutorial_voice_configuration_missing");
    await expect(assertTutorialAssistanceEnvironment({}, provider)).resolves.toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
  });

  // WI-10006664: phone deploy mints the bearer secret into papercusp-phone/portal.env;
  // a Portal started without it refuses every signed-in call 503 portal_app_auth_unavailable.
  it("passes the phone app's portal bearer secret from its own config file, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "papercusp-cloud-portal-sibling-env-"));
    try {
      mkdirSync(join(dir, "papercusp-phone"), { recursive: true });
      writeFileSync(
        join(dir, "papercusp-phone/portal.env"),
        "PHONE_AUTH_SECRET=phone-sentinel\nPHONE_OWNER_SUBJECT_ID=not-for-the-portal\nPORTAL_PHONE_ORIGIN=http://127.0.0.1:8793\n",
      );
      expect(siblingAppEnv({ XDG_CONFIG_HOME: dir }, {})).toEqual({
        PHONE_AUTH_SECRET: "phone-sentinel",
        PORTAL_PHONE_ORIGIN: "http://127.0.0.1:8793",
      });
      // HOME/.config is the default when XDG_CONFIG_HOME is unset (systemd user units).
      const home = mkdtempSync(join(tmpdir(), "papercusp-cloud-portal-sibling-home-"));
      try {
        mkdirSync(join(home, ".config/papercusp-phone"), { recursive: true });
        writeFileSync(join(home, ".config/papercusp-phone/portal.env"), "PHONE_AUTH_SECRET=from-home\n");
        expect(siblingAppEnv({ HOME: home }, {})).toEqual({ PHONE_AUTH_SECRET: "from-home" });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets the hosted env win, honours an explicit file override, and tolerates a missing file", () => {
    const read = (path: string): Record<string, string> => (path === "/explicit/portal.env" ? { PHONE_AUTH_SECRET: "explicit" } : {});
    expect(siblingAppEnv({ PAPERCUSP_PORTAL_PHONE_ENV_FILE: "/explicit/portal.env", HOME: "/h" }, {}, read))
      .toEqual({ PHONE_AUTH_SECRET: "explicit" });
    expect(siblingAppEnv({ PAPERCUSP_PORTAL_PHONE_ENV_FILE: "/explicit/portal.env" }, { PHONE_AUTH_SECRET: "hosted" }, read))
      .toEqual({});
    expect(siblingAppEnv({ HOME: "/nonexistent-home-for-test" }, {})).toEqual({});
  });

  it("the boot path applies the sibling env to the Portal child", () => {
    const source = readFileSync(LAUNCHER_SCRIPT, "utf8");
    const main = source.slice(source.indexOf("async function main"));
    expect(main).toMatch(/Object\.assign\(childEnv, siblingAppEnv\(process\.env, childEnv\)\)/);
    expect(main.indexOf("siblingAppEnv(")).toBeLessThan(main.indexOf("spawn("));
  });
});

function staleTestSystemctl(files: Fixture): string {
  const systemctl = join(files.binDir, "systemctl");
  writeFileSync(
    systemctl,
    `#!/usr/bin/env bash
set -eu
shift
case "$1" in
  daemon-reload|enable|stop|reset-failed|start) exit 0 ;;
  restart) printf '%s\\0%s\\0' node '${files.portalRoot}/scripts/start-web.mjs' > '${files.procRoot}/4242/cmdline'; exit 0 ;;
  is-active) exit 0 ;;
  show) printf '4242\n'; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(systemctl, 0o755);
  return systemctl;
}

function run(files: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...envFor(files), ...extraEnv },
  });
}

function artifactProcessTree(files: Fixture, hosted: boolean, branching: boolean, stale = false) {
  const current = join(files.runtimeRoot, "releases", "build-one");
  const old = join(files.runtimeRoot, "releases", "build-old");
  mkdirSync(old, { recursive: true });
  for (const pid of ["4350", "4400", "4500"]) {
    mkdirSync(join(files.procRoot, pid, "task", pid), { recursive: true });
    writeFileSync(join(files.procRoot, pid, "cmdline"), Buffer.from("node\0helper\0"));
    symlinkSync(files.portalRoot, join(files.procRoot, pid, "cwd"), "dir");
  }
  const startWeb = Buffer.from(`node\0${files.portalRoot}/scripts/start-web.mjs\0`);
  writeFileSync(join(files.procRoot, "4242", "cmdline"), hosted
    ? Buffer.from(`node\0${files.binDir}/papercusp-cloud-portal-launcher.ts\0`)
    : startWeb);
  if (hosted) writeFileSync(join(files.procRoot, "4350", "cmdline"), startWeb);
  writeFileSync(join(files.procRoot, "4242", "task", "4242", "children"),
    `${branching ? "4400 " : ""}${hosted ? "4350" : "4343"}`);
  if (hosted) writeFileSync(join(files.procRoot, "4350", "task", "4350", "children"),
    `${branching ? "4500 " : ""}4343`);
  if (stale) {
    rmSync(join(files.procRoot, "4343", "cwd"));
    symlinkSync(old, join(files.procRoot, "4343", "cwd"), "dir");
    // A current cwd on a sibling of start-web cannot prove its serving lineage.
    rmSync(join(files.procRoot, "4400", "cwd"));
    symlinkSync(current, join(files.procRoot, "4400", "cwd"), "dir");
  }
}

function artifactTestSystemctl(files: Fixture, refreshOnRestart = false): string {
  const systemctl = join(files.binDir, "systemctl-artifact");
  writeFileSync(systemctl, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
shift
case "$1" in
  daemon-reload|enable|stop|reset-failed|start) exit 0 ;;
  restart)
    ${refreshOnRestart ? `rm '${files.procRoot}/4343/cwd'
    ln -s '${files.runtimeRoot}/releases/build-one' '${files.procRoot}/4343/cwd'` : ":"}
    exit 0 ;;
  is-active) exit 0 ;;
  show) printf '4242\\n'; exit 0 ;;
  *) exit 1 ;;
esac
`);
  chmodSync(systemctl, 0o755);
  return systemctl;
}

describe("Cloud Portal systemd deployment contract", () => {
  it("ships the documented handoff entrypoint as a directly executable script", () => {
    const result = spawnSync(SCRIPT, ["--help"], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Usage: deploy-cloud-portal.sh [--render-only|--install-only|--handoff]",
    );
  });

  it("renders machine-specific paths with systemd escaping and keeps the source template neutral", () => {
    const files = fixture();
    try {
      writeFileSync(join(files.dir, "hosted.env"), "PAPERCUSP_HOSTED_PUBLIC_ORIGIN=https://example.test\n");
      const result = run(files, ["--render-only"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`WorkingDirectory=${files.portalRoot.replaceAll(" ", "\\ ")}`);
      expect(result.stdout).toContain("ExecStart=");
      expect(result.stdout).toContain("papercusp-cloud-portal-launcher.ts");
      expect(result.stdout).toContain("Environment=NODE_ENV=production");
      expect(result.stdout).toContain("Environment=HOSTNAME=127.0.0.1");
      expect(result.stdout).toContain("Type=notify");
      expect(result.stdout).toContain("NotifyAccess=all");
      expect(result.stdout).toContain("WatchdogSec=15s");
      // The 2026-10-06 crash recovery needed 90.71s of PostgreSQL fsync before
      // the Portal could answer HTTP. Keep the readiness budget above that
      // measured recovery and leave systemd enough time to observe the result.
      const readinessTimeoutMs = Number(
        result.stdout.match(/^Environment=PORTAL_READINESS_TIMEOUT_MS=(\d+)$/m)?.[1],
      );
      const systemdStartTimeoutMs = Number(
        result.stdout.match(/^TimeoutStartSec=(\d+)s$/m)?.[1],
      ) * 1_000;
      expect(readinessTimeoutMs).toBeGreaterThanOrEqual(180_000);
      expect(systemdStartTimeoutMs).toBeGreaterThanOrEqual(readinessTimeoutMs + 60_000);
      expect(result.stdout).toContain(
        `Environment=PORTAL_RUNTIME_ROOT=${files.runtimeRoot.replaceAll(" ", "\\ ")}`,
      );
      expect(result.stdout).not.toContain("EnvironmentFile=");
      expect(result.stdout).toContain("PAPERCUSP_PORTAL_HOSTED_ENV_FILE=");
      expect(result.stdout).toContain("PAPERCUSP_INTEGRATION_ROOT=");
      expect(result.stdout).toContain("scripts/start-web.mjs");
      expect(result.stdout).not.toContain(`${files.portalRoot.replaceAll(" ", "\\ ")}/.portal-runtime`);
      expect(result.stdout).not.toContain("ExecStart=" + process.execPath + " " + files.portalRoot + "/node_modules/.bin/next dev");
      expect(result.stdout).toContain("KillMode=control-group");

      const template = readFileSync(TEMPLATE, "utf8");
      expect(template).toContain("@PORTAL_ROOT@");
      expect(template).toContain("@RUNTIME_ROOT@");
      expect(template).toContain("@TSX@");
      expect(template).not.toMatch(/\/home\/[a-z]/i);
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("restarts the front door even when the launcher exits 0 on a readiness failure (WI-10002337)", () => {
    const files = fixture();
    try {
      writeFileSync(join(files.dir, "hosted.env"), "PAPERCUSP_HOSTED_PUBLIC_ORIGIN=https://example.test\n");
      const result = run(files, ["--render-only"]);
      expect(result.status, result.stderr).toBe(0);

      // The launcher reports a failed readiness probe as an ORDERLY shutdown and
      // exits 0 ("portal_start_readiness_failed:watchdog-notify:portal_systemd_notify_exit_1",
      // then sql-stopped / postgres-stopped), which systemd records as
      // Result=success ExecMainStatus=0. Restart=on-failure does not retry a
      // clean exit, so that combination left app.papercusp.com's only origin
      // down for ~9h on 2026-09-21 until a hand `systemctl start` — with the
      // same binary coming straight back up healthy. Restart=always is what
      // makes the most likely boot fault recoverable.
      expect(result.stdout).toContain("Restart=always");
      expect(result.stdout).not.toContain("Restart=on-failure");

      // Restart=always is only safe because the start limiter still bounds a
      // genuine crash loop; assert the pair together so neither can be dropped
      // in isolation.
      expect(result.stdout).toContain("StartLimitIntervalSec=300");
      expect(result.stdout).toContain("StartLimitBurst=5");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("atomically installs, verifies, reloads, and enables without starting the backend", () => {
    const files = fixture();
    const systemctl = join(files.binDir, "systemctl");
    const systemdAnalyze = join(files.binDir, "systemd-analyze");
    writeFileSync(
      systemctl,
      `#!/usr/bin/env bash
set -eu
  printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
  shift
case "$1" in
  daemon-reload|enable) exit 0 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(systemctl, 0o755);
    writeFileSync(
      systemdAnalyze,
      `#!/usr/bin/env bash
set -eu
test "$1" = verify
printf '%s\\n' "$2" > "$ANALYZE_LOG"
case "$2" in
  *.service) exit 0 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(systemdAnalyze, 0o755);
    try {
      const result = run(files, ["--install-only"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_SYSTEMD_ANALYZE: systemdAnalyze,
        SYSTEMCTL_LOG: files.logPath,
        ANALYZE_LOG: files.analyzeLogPath,
      });
      expect(result.status, result.stderr).toBe(0);
      const installed = readFileSync(join(files.unitDir, "papercusp-cloud-portal.service"), "utf8");
      expect(installed).toContain("WorkingDirectory=");
      expect(installed).toContain("ExecStart=");
      expect(installed).toContain("Environment=NODE_ENV=production");
      expect(installed).not.toContain("EnvironmentFile=");
      expect(installed).toContain("PAPERCUSP_PORTAL_HOSTED_ENV_FILE=");
      expect(installed).toContain("papercusp-cloud-portal-launcher.ts");
      expect(installed).toContain("Type=notify");
      expect(installed).toContain("NotifyAccess=all");
      expect(installed).toContain("WatchdogSec=15s");
      expect(readFileSync(files.logPath, "utf8")).toBe(
        "--user daemon-reload\n--user enable papercusp-cloud-portal.service\n",
      );
      expect(result.stdout).toContain("not started");
      expect(readdirSync(files.unitDir)).toEqual(["papercusp-cloud-portal.service"]);
      expect(readdirSync(join(files.dir, "tmp"))).toEqual([]);
      expect(readFileSync(files.analyzeLogPath, "utf8")).toMatch(/\.service\n$/);
      expect(readFileSync(join(files.binDir, "papercusp-cloud-portal-proxy.mjs"), "utf8")).toBe(
        readFileSync(PROXY_SCRIPT, "utf8"),
      );
      expect(readFileSync(join(files.binDir, "papercusp-cloud-portal-launcher.ts"), "utf8")).toBe(
        readFileSync(LAUNCHER_SCRIPT, "utf8"),
      );
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("refuses installation until the standalone production artifact has been built", () => {
    const files = fixture();
    try {
      rmSync(join(files.runtimeRoot, "current", "standalone-entry.mjs"));
      const result = run(files, ["--render-only"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal production artifact is missing");
      expect(result.stderr).toContain("run npm run build first");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("keeps the handoff safety boundary around the validated backend, not the :3081 proxy", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain("validate_legacy_listener");
    expect(script).toContain("START_WEB");
    expect(script).toContain("CURRENT_RELEASE_LINK");
    expect(script).toContain("PORTAL_RUNTIME_ROOT");
    expect(script).toContain('CURRENT_RELEASE_LINK="$PORTAL_RUNTIME_ROOT/current"');
    expect(script).toContain("process_lineage_is_next_dev");
    expect(script).toContain("restore_legacy_listener");
    expect(script).toContain("managed_unit_runs_current_artifact");
    expect(script).toContain('cd -- "$PORTAL_ROOT"');
    expect(script).toContain('TEMP_DIR="${PAPERCUSP_CLOUD_PORTAL_TMPDIR:-${TMPDIR:-/tmp}}"');
    expect(script).toContain('mktemp "$TEMP_DIR/.${UNIT_NAME}.tmp.XXXXXX.service"');
    expect(script).not.toContain('mktemp "$UNIT_DIR/.${UNIT_NAME}.tmp.XXXXXX.service"');
    expect(script).toContain('TEMP_DIR="/var/tmp"');
    expect(script).toContain("health_check \"$PORTAL_PORT\"");
    expect(script).toContain("systemctl_user stop \"$UNIT_NAME\"");
    expect(script).toContain("papercusp-cloud-portal-3081.service");
    expect(script).not.toMatch(/systemctl_user\s+stop[^\n]*3081/);
    expect(script.indexOf("validate_legacy_listener")).toBeLessThan(script.indexOf("stop_legacy_listener"));
    expect(script.indexOf("restore_legacy_listener")).toBeGreaterThan(script.indexOf("start_managed"));
  });

  it.each([
    ["hosted launcher", true, false],
    ["direct launcher with branching children", false, true],
    ["hosted launcher with branching children", true, true],
  ] as const)("keeps a current artifact idempotent through a %s", (_name, hosted, branching) => {
    const files = fixture();
    artifactProcessTree(files, hosted, branching);
    const systemctl = artifactTestSystemctl(files);
    try {
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        SYSTEMCTL_LOG: files.logPath,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("already active and healthy; legacy handoff not needed");
      expect(readFileSync(files.logPath, "utf8")).not.toContain("--user restart papercusp-cloud-portal.service");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it.each([true, false])("verifies the hosted serving lineage after restart (refresh=%s)", (refresh) => {
    const files = fixture();
    artifactProcessTree(files, true, true, true);
    const systemctl = artifactTestSystemctl(files, refresh);
    try {
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        SYSTEMCTL_LOG: files.logPath,
      });
      const calls = readFileSync(files.logPath, "utf8");
      expect(calls).toContain("--user restart papercusp-cloud-portal.service");
      expect(result.status, result.stderr).toBe(refresh ? 0 : 1);
      if (refresh) {
        expect(result.stdout).toContain("runs the standalone production artifact and passed health check");
        expect(calls).not.toContain("--user stop papercusp-cloud-portal.service");
      } else {
        expect(result.stdout).not.toContain("handoff complete");
        expect(result.stderr).toContain("managed portal restart/health failed");
        expect(calls).toContain("--user stop papercusp-cloud-portal.service");
      }
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("restarts an active managed stale generation instead of misreporting it as current", () => {
    const files = fixture();
    const systemctl = join(files.binDir, "systemctl");
    writeFileSync(systemctl, `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
shift
case "$1" in
  daemon-reload|enable|stop|reset-failed|start) exit 0 ;;
  restart) printf '%s\\0%s\\0' node '${files.portalRoot}/scripts/start-web.mjs' > '${files.procRoot}/4242/cmdline'; exit 0 ;;
  is-active) exit 0 ;;
  show) printf '4242\n'; exit 0 ;;
  *) exit 1 ;;
esac
`);
    chmodSync(systemctl, 0o755);
    try {
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        SYSTEMCTL_LOG: files.logPath,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("running a stale command; restarting onto the standalone artifact");
      expect(result.stdout).toContain("runs the standalone production artifact and passed health check");
      expect(readFileSync(files.logPath, "utf8")).toContain("--user restart papercusp-cloud-portal.service\n");
      expect(readFileSync(files.logPath, "utf8")).toContain("--user enable --now papercusp-cloud-portal-reconcile.timer\n");
      expect(readFileSync(join(files.unitDir, "papercusp-cloud-portal-reconcile.service"), "utf8"))
        .toContain("reconcile-cloud-portal.mjs");
      expect(readFileSync(join(files.unitDir, "papercusp-cloud-portal-reconcile.service"), "utf8"))
        .not.toContain("EnvironmentFile=-%h/.config/papercusp/portal-public-links.env");
      expect(readFileSync(join(files.unitDir, "papercusp-cloud-portal-reconcile.service"), "utf8"))
        .toContain("PAPERCUSP_CLOUD_PORTAL_PUBLIC_LINKS_ENV=%h/.config/papercusp/portal-public-links.env");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("recovers an activating managed unit without treating its transient listener as legacy", () => {
    const files = fixture();
    const managedCgroup = "/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-cloud-portal.service";
    const stopped = join(files.dir, "managed-stopped");
    const systemctl = join(files.binDir, "systemctl-activating");
    const ss = join(files.binDir, "ss-managed-listener");
    const curl = join(files.binDir, "curl-managed-listener");
    const kill = join(files.binDir, "kill-recording");
    const killLog = join(files.dir, "kill.log");

    writeFileSync(join(files.procRoot, "4242", "cgroup"), `0::${managedCgroup}\n`);
    writeFileSync(killLog, "");
    writeFileSync(systemctl, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
shift
case "$1" in
  daemon-reload|enable|reset-failed|start) exit 0 ;;
  stop) : > '${stopped}'; exit 0 ;;
  is-active) exit 1 ;;
  show)
    case "$*" in
      *--property=ControlGroup*) printf '%s\\n' '${managedCgroup}' ;;
      *--property=MainPID*) printf '4242\\n' ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`);
    chmodSync(systemctl, 0o755);
    writeFileSync(ss, `#!/usr/bin/env bash
set -eu
[[ -e '${stopped}' ]] && exit 0
printf '%s\\n' 'LISTEN 0 511 127.0.0.1:3801 0.0.0.0:* users:(("node",pid=4242,fd=18))'
`);
    chmodSync(ss, 0o755);
    writeFileSync(curl, `#!/usr/bin/env bash
set -eu
[[ -e '${stopped}' ]] || exit 7
exit 0
`);
    chmodSync(curl, 0o755);
    writeFileSync(kill, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> '${killLog}'
`);
    chmodSync(kill, 0o755);

    try {
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_SS: ss,
        PAPERCUSP_CLOUD_PORTAL_CURL: curl,
        PAPERCUSP_CLOUD_PORTAL_KILL: kill,
        SYSTEMCTL_LOG: files.logPath,
      });
      const calls = readFileSync(files.logPath, "utf8");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("started papercusp-cloud-portal.service and verified");
      expect(result.stderr).not.toContain("legacy :3801 listener is not healthy");
      expect(calls).toContain("--user show papercusp-cloud-portal.service --property=ControlGroup --value");
      expect(calls).toContain("--user stop papercusp-cloud-portal.service");
      expect(calls).toContain("--user start papercusp-cloud-portal.service");
      expect(calls.indexOf("--user stop papercusp-cloud-portal.service"))
        .toBeLessThan(calls.indexOf("--user start papercusp-cloud-portal.service"));
      expect(readFileSync(killLog, "utf8")).toBe("");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("does not stop an unhealthy listener outside the managed ControlGroup", () => {
    const files = fixture();
    const managedCgroup = "/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-cloud-portal.service";
    const externalCgroup = "/user.slice/user-1000.slice/user@1000.service/app.slice/other.service";
    const systemctl = join(files.binDir, "systemctl-external-listener");
    const ss = join(files.binDir, "ss-external-listener");
    const curl = join(files.binDir, "curl-unhealthy-listener");
    const kill = join(files.binDir, "kill-recording");
    const killLog = join(files.dir, "kill.log");

    writeFileSync(join(files.procRoot, "4242", "cgroup"), `0::${externalCgroup}\n`);
    writeFileSync(killLog, "");
    writeFileSync(systemctl, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
shift
case "$1" in
  daemon-reload|enable|reset-failed|start|stop) exit 0 ;;
  is-active) exit 1 ;;
  show)
    case "$*" in
      *--property=ControlGroup*) printf '%s\\n' '${managedCgroup}' ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`);
    chmodSync(systemctl, 0o755);
    writeFileSync(ss, `#!/usr/bin/env bash
set -eu
printf '%s\\n' 'LISTEN 0 511 127.0.0.1:3801 0.0.0.0:* users:(("node",pid=4242,fd=18))'
`);
    chmodSync(ss, 0o755);
    writeFileSync(curl, `#!/usr/bin/env bash
set -eu
exit 7
`);
    chmodSync(curl, 0o755);
    writeFileSync(kill, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> '${killLog}'
`);
    chmodSync(kill, 0o755);

    try {
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_SS: ss,
        PAPERCUSP_CLOUD_PORTAL_CURL: curl,
        PAPERCUSP_CLOUD_PORTAL_KILL: kill,
        SYSTEMCTL_LOG: files.logPath,
      });
      const calls = readFileSync(files.logPath, "utf8");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("legacy :3801 listener is not healthy; refusing handoff");
      expect(calls).toContain("--user show papercusp-cloud-portal.service --property=ControlGroup --value");
      expect(calls).not.toContain("--user stop papercusp-cloud-portal.service");
      expect(readFileSync(killLog, "utf8")).toBe("");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("suppresses transient curl noise and reports one bounded health failure diagnostic", () => {
    const transient = fixture();
    const transientSystemctl = staleTestSystemctl(transient);
    const transientCurl = join(transient.binDir, "curl-transient");
    const transientState = join(transient.dir, "curl-transient-state");
    writeFileSync(
      transientCurl,
      `#!/usr/bin/env bash
set -eu
if [[ ! -e '${transientState}' ]]; then
  : > '${transientState}'
  printf '%s\\n' 'curl: (7) transient fixture noise' >&2
  exit 7
fi
exit 0
`,
    );
    chmodSync(transientCurl, 0o755);

    try {
      const result = run(transient, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: transientSystemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: transientCurl,
        PAPERCUSP_CLOUD_PORTAL_HEALTH_WAIT_SEC: "1",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("curl: (7) transient fixture noise");
      expect(result.stdout).toContain("handoff complete: papercusp-cloud-portal.service runs the standalone production artifact");
    } finally {
      rmSync(transient.dir, { recursive: true, force: true });
    }

    const failing = fixture();
    const failingSystemctl = join(failing.binDir, "systemctl-failing-health");
    const failingCurl = join(failing.binDir, "curl-failing-health");
    writeFileSync(
      failingSystemctl,
      `#!/usr/bin/env bash
set -eu
shift
case "$1" in
  daemon-reload|enable|stop|reset-failed|start) exit 0 ;;
  is-active) exit 1 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(failingSystemctl, 0o755);
    writeFileSync(
      failingCurl,
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' 'curl: (7) final fixture noise' >&2
exit 7
`,
    );
    chmodSync(failingCurl, 0o755);

    try {
      const result = run(failing, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: failingSystemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: failingCurl,
        PAPERCUSP_CLOUD_PORTAL_SS: "/bin/false",
        PAPERCUSP_CLOUD_PORTAL_HEALTH_WAIT_SEC: "1",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("curl: (7) final fixture noise");
      expect(result.stderr).toContain(
        "cloud-portal: ERROR: health check failed for http://127.0.0.1:3801/ after 2 attempt(s)",
      );
      expect(result.stderr.match(/health check failed for/g)).toHaveLength(1);
    } finally {
      rmSync(failing.dir, { recursive: true, force: true });
    }
  });

  it("refuses handoff onto a stale current release when the checkout has moved on (WI-2141210)", () => {
    const files = fixture();
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2000-01-01T00:00:00.000Z");
      const result = run(files, ["--handoff"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal current release looks STALE");
      expect(result.stderr).toContain("commit newer than the release");
      expect(result.stderr).toContain("PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE=1");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("refuses handoff when the checkout has uncommitted changes, even with a future-dated release", () => {
    const files = fixture();
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2099-01-01T00:00:00.000Z");
      writeFileSync(join(files.portalRoot, "package.json"), '{"name":"portal-fixture","dirty":true}\n');
      const result = run(files, ["--handoff"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal current release looks STALE");
      expect(result.stderr).toContain("uncommitted changes");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("deploys cleanly when the release postdates the checkout's last commit", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2099-01-01T00:00:00.000Z");
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("STALE");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("deploys a stale current release when explicitly overridden (deliberate rollback)", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2000-01-01T00:00:00.000Z");
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE: "1",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("WARNING: current release looks STALE");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("judges freshness by CONTENT digest: a byte-identical checkout deploys even when git-sync left it dirty with an older publishedAt (EI-22388584299827941)", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      gitCommitAll(files.portalRoot, "initial");
      // Both legacy stale signals are present: an old publishedAt AND uncommitted changes.
      writeReleaseManifest(files.runtimeRoot, "2000-01-01T00:00:00.000Z", RELEASE_DIGEST);
      writeDigestCli(files.portalRoot, RELEASE_DIGEST);
      writeFileSync(join(files.portalRoot, "package.json"), '{"name":"portal-fixture","dirty":true}\n');
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        PAPERCUSP_CLOUD_PORTAL_NODE: process.execPath,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("STALE");
      expect(result.stdout).toContain("source digest matches");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("refuses handoff when the checkout's content digest differs from the release's, naming both digests", () => {
    const files = fixture();
    try {
      gitCommitAll(files.portalRoot, "initial");
      // A future-dated, clean-looking release: the git heuristic alone would pass it.
      writeReleaseManifest(files.runtimeRoot, "2099-01-01T00:00:00.000Z", RELEASE_DIGEST);
      writeDigestCli(files.portalRoot, "d".repeat(64));
      gitCommitAll(files.portalRoot, "add digest cli");
      const result = run(files, ["--handoff"], { PAPERCUSP_CLOUD_PORTAL_NODE: process.execPath });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("portal current release looks STALE");
      expect(result.stderr).toContain("source digest");
      expect(result.stderr).toContain("differs from the release's");
      expect(result.stderr).toContain(RELEASE_DIGEST.slice(0, 12));
      expect(result.stderr).toContain("PAPERCUSP_CLOUD_PORTAL_ALLOW_STALE_RELEASE=1");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("falls back to the git heuristic when the manifest carries a digest but the checkout has no digest CLI", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      gitCommitAll(files.portalRoot, "initial");
      writeReleaseManifest(files.runtimeRoot, "2099-01-01T00:00:00.000Z", RELEASE_DIGEST);
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
        PAPERCUSP_CLOUD_PORTAL_NODE: process.execPath,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("STALE");
      expect(result.stdout).not.toContain("source digest matches");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("does not check staleness when the checkout is not a git repository (skip, not refuse)", () => {
    const files = fixture();
    const systemctl = staleTestSystemctl(files);
    try {
      writeReleaseManifest(files.runtimeRoot, "2000-01-01T00:00:00.000Z");
      const result = run(files, ["--handoff"], {
        PAPERCUSP_CLOUD_PORTAL_SYSTEMCTL: systemctl,
        PAPERCUSP_CLOUD_PORTAL_CURL: "/bin/true",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("STALE");
    } finally {
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("documents the separate proxy and the managed cgroup verification", () => {
    const readme = readFileSync(README, "utf8");
    expect(readme).toContain("deploy-cloud-portal.sh --handoff");
    expect(readme).toContain("papercusp-cloud-portal-3081.service");
    expect(readme).toContain("ControlGroup");
    expect(readme).toContain("bounded outage window");
  });
});

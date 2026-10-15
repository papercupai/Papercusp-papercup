/**
 * Boot the hosted Portal without placing integration secrets in systemd or a
 * plaintext checkout file. The hosted env file contains only literals and
 * `integration:NAME` references; each reference is resolved in this process,
 * then exposed to the standalone child through an ephemeral env slot using the
 * generic `env:NAME` resolver already bundled by the Portal.
 */
import { readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type HostedSecretRefResolver = (reference: string) => Promise<string>;

/** PID-anchored traversal for hosted evidence collectors. Secrets are resolved
 * in descendants of the systemd launcher, including children forked by worker
 * threads; the service MainPID environment alone is not its effective config. */
export function hostedServiceProcessIds(rootPid: number, {
  readFile = (path: string) => readFileSync(path, "utf8"),
  readDir = (path: string) => readdirSync(path),
  maxProcesses = 1024,
} = {}): number[] {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) throw new Error("hosted_process_root_invalid");
  const pending = [rootPid];
  const visited = new Set<number>();
  for (let index = 0; index < pending.length; index++) {
    const pid = pending[index];
    if (visited.has(pid)) continue;
    if (visited.size >= maxProcesses) throw new Error("hosted_process_tree_incomplete");
    visited.add(pid);
    let threads: string[];
    try { threads = readDir(`/proc/${pid}/task`); }
    catch (error) {
      // A child can exit while the snapshot is read; a missing service root
      // cannot establish an evidence inventory.
      if (pid === rootPid) throw error;
      continue;
    }
    for (const tid of threads.filter((value) => /^\d+$/.test(value))) {
      let children: string;
      try { children = readFile(`/proc/${pid}/task/${tid}/children`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const value of children.trim().split(/\s+/)) {
        const child = Number(value);
        if (Number.isSafeInteger(child) && child > 0 && !visited.has(child)) pending.push(child);
      }
    }
  }
  return [...visited];
}

function positiveSetting(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`portal_hosted_invalid_${name.toLowerCase()}`);
  }
  return Number(value);
}

const INTEGRATION_PREFIX = "integration:";
const SAFE_OPERATOR_ENV = [
  "HARNESS_ADMIN_DATABASE_URL",
  "PAPERCUSP_WORKSPACE",
  "PAPERCUSP_INTEGRATION_ROOT",
] as const;

/**
 * Sibling apps whose own deploy mints the Portal<->app bearer secret into that
 * app's config file: infra/phone-app/deploy.sh writes PHONE_AUTH_SECRET to
 * papercusp-phone/portal.env, and the phone sidecar verifies bearers with the
 * same file. The Portal proxy signs every signed-in request to the app with it,
 * so without it each one is refused 503 `portal_app_auth_unavailable` (WI-10006664:
 * no hosted user could start a Phone call). Only these portal-facing keys are
 * copied, never the whole file, and a value the hosted env already sets wins.
 */
const SIBLING_APP_ENV = [
  {
    fileEnv: "PAPERCUSP_PORTAL_PHONE_ENV_FILE",
    defaultConfigPath: "papercusp-phone/portal.env",
    keys: ["PHONE_AUTH_SECRET", "PORTAL_PHONE_ORIGIN"],
  },
] as const;

/** The sibling-app keys to add to the Portal child's env (values never logged). */
export function siblingAppEnv(
  env: NodeJS.ProcessEnv,
  existing: Record<string, string | undefined>,
  read: (path: string) => Record<string, string> = readOptional,
): Record<string, string> {
  const added: Record<string, string> = {};
  const configHome = env.XDG_CONFIG_HOME?.trim() || (env.HOME?.trim() ? join(env.HOME.trim(), ".config") : "");
  for (const sibling of SIBLING_APP_ENV) {
    const file = env[sibling.fileEnv]?.trim() || (configHome ? join(configHome, sibling.defaultConfigPath) : "");
    if (!file) continue;
    const values = read(file);
    for (const key of sibling.keys) {
      if (existing[key]?.trim()) continue;
      const value = values[key]?.trim();
      if (value) added[key] = value;
    }
  }
  return added;
}

/** Parse the small dotenv subset used by the checked-in deployment env files. */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const name = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    let value = assignment.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[name] = value;
  }
  return result;
}

/**
 * Replace encrypted-store references with env references understood by the
 * Portal's prebundled hosted-auth runtime. The returned object contains the
 * secret slots as well as the rewritten config names; values are never logged.
 */
export async function resolveIntegrationReferences(
  source: Record<string, string>,
  resolve: HostedSecretRefResolver,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = { ...source };
  for (const [name, reference] of Object.entries(source)) {
    if (!reference.startsWith(INTEGRATION_PREFIX)) continue;
    const integrationName = reference.slice(INTEGRATION_PREFIX.length).trim();
    if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(integrationName)) {
      throw new Error(`portal_hosted_secret_ref_malformed:${reference}`);
    }
    const slot = `PAPERCUSP_CLOUD_PORTAL_SECRET_${integrationName}`;
    const value = await resolve(reference);
    if (!value.trim()) throw new Error(`portal_hosted_secret_ref_empty:${reference}`);
    resolved[slot] = value.trim();
    resolved[name] = `env:${slot}`;
  }
  return resolved;
}

/** Fail before hosted tutorial acceptance if its lesson-only provider cannot override prompts. */
export async function assertTutorialVoiceEnvironment(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const apiKey = env.PORTAL_ELEVENLABS_API_KEY?.trim();
  const agentId = env.PORTAL_ELEVENLABS_AGENT_ID?.trim();
  if (!apiKey || !agentId) throw new Error("tutorial_voice_configuration_missing");
  if (env.PORTAL_ELEVENLABS_PROMPT_OVERRIDE !== "1") {
    throw new Error("tutorial_voice_prompt_override_required");
  }
  const response = await fetchImpl(
    "https://api.elevenlabs.io/v1/convai/agents/" + encodeURIComponent(agentId),
    { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error("tutorial_voice_provider_refused");
  const agent = await response.json().catch(() => null);
  if (agent?.platform_settings?.overrides?.conversation_config_override?.agent?.prompt?.prompt !== true) {
    throw new Error("tutorial_voice_prompt_override_required");
  }
}

/** Exercise the same public, lesson-only brain before hosted acceptance starts.
 * HTTP 200 alone is insufficient: backend login failures arrive inside SSE. */
export async function assertTutorialAssistanceEnvironment(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (env.PORTAL_TUTORIAL_VOICE_SERVED_E2E === "1") {
    await assertTutorialVoiceEnvironment(env, fetchImpl);
  }
  if (env.PORTAL_TUTORIAL_SERVED_E2E !== "1") return;
  let origin: URL;
  try { origin = new URL(env.PORTAL_OPERATOR_ORIGIN ?? ""); }
  catch { throw new Error("tutorial_help_operator_origin_required"); }
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("tutorial_help_operator_origin_required");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response: Response | undefined;
  try {
    response = await fetchImpl(new URL("/api/agent-mcp/operator-converse", origin), {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ messages: [{ role: "user", content: "Explain who bills infrastructure in this lesson." }],
        trigger: "user_message", modality: "text", hostTrust: "public",
        lessonContext: { version: 3, step: "billing", status: "ready" } }),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("tutorial_help_provider_unavailable");
    }
    const { parseSseStream } = await import("@papercusp/sse");
    for await (const event of parseSseStream(response.body)) {
      if (event.event === "error") throw new Error("tutorial_help_provider_unavailable");
      if (event.event !== "done") continue;
      const result = JSON.parse(event.data) as { answer?: unknown };
      if (typeof result.answer !== "string" || !result.answer.trim()) {
        throw new Error("tutorial_help_provider_unavailable");
      }
      return;
    }
    throw new Error("tutorial_help_provider_unavailable");
  } catch {
    // Provider diagnostics can contain credentials or private prompt data.
    throw new Error("tutorial_help_provider_unavailable");
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await response?.body?.cancel().catch(() => {});
  }
}

function readOptional(path: string | undefined): Record<string, string> {
  if (!path) return {};
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const portalRoot = process.env.PAPERCUSP_PORTAL_ROOT?.trim();
  const startWeb = process.env.PAPERCUSP_PORTAL_START_WEB?.trim();
  const hostedEnvFile = process.env.PAPERCUSP_PORTAL_HOSTED_ENV_FILE?.trim();
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (!portalRoot || !startWeb || !hostedEnvFile || !integrationRoot) {
    throw new Error("portal_hosted_launcher_configuration_missing");
  }

  const hosted = parseEnvFile(readFileSync(hostedEnvFile, "utf8"));
  const operatorFile = readOptional(process.env.PAPERCUSP_PORTAL_OPERATOR_ENV_FILE?.trim());
  const adminDatabaseUrl =
    process.env.HARNESS_ADMIN_DATABASE_URL
    ?? operatorFile.HARNESS_ADMIN_DATABASE_URL
    ?? operatorFile.DATABASE_URL;
  if (!adminDatabaseUrl) throw new Error("portal_hosted_admin_database_url_missing");
  // Integration references are resolved in this launcher process, before the
  // Portal child starts. Give that reader the same admin URL the child receives;
  // setting it only on childEnv makes the resolver silently read the wrong store.
  process.env.HARNESS_ADMIN_DATABASE_URL = adminDatabaseUrl;
  // The launcher is copied to ~/.local/bin, outside the repo's tsconfig path
  // map. Load the canonical resolver by absolute URL so a service restart does
  // not depend on the current working directory or a symlinked node_modules.
  const resolverModule = await import(
    pathToFileURL(join(integrationRoot, "packages/operator-core/lib/auth/hosted/secret-ref.ts")).href,
  ) as { resolveHostedSecretRef: HostedSecretRefResolver };
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...hosted };
  for (const name of SAFE_OPERATOR_ENV) {
    if (operatorFile[name]) childEnv[name] = operatorFile[name];
  }
  // The encrypted store reader uses the admin URL. Keep DATABASE_URL out of
  // the child so the Portal's own store remains its persistent/embedded store,
  // while the operator-state reader still has its database connection.
  childEnv.HARNESS_ADMIN_DATABASE_URL = adminDatabaseUrl;
  childEnv.PAPERCUSP_INTEGRATION_ROOT = integrationRoot;
  childEnv.PORTAL_LOCAL_MODE = "0";
  childEnv.PORTAL_USE_MEMORY_STORE = "0";
  childEnv.HOSTNAME = childEnv.HOSTNAME || "127.0.0.1";
  Object.assign(childEnv, siblingAppEnv(process.env, childEnv));

  const rewritten = await resolveIntegrationReferences(hosted, resolverModule.resolveHostedSecretRef);
  Object.assign(childEnv, rewritten);
  await assertTutorialAssistanceEnvironment(childEnv);

  // This maintained launcher is the service's supervision boundary. The Portal
  // checkout remains immutable/read-only here, and must not run a competing
  // fork-per-heartbeat notifier underneath this parent.
  const { createSystemdNotifier } = process.env.NOTIFY_SOCKET
    ? await import(pathToFileURL(join(integrationRoot, "packages/operator-core/lib/systemd-readiness.ts")).href)
    : { createSystemdNotifier: () => null };
  const notifier = createSystemdNotifier(process.env, positiveSetting("PORTAL_SYSTEMD_NOTIFY_TIMEOUT_MS", 2_000));
  if (notifier) {
    delete childEnv.NOTIFY_SOCKET;
    delete childEnv.WATCHDOG_USEC;
    delete childEnv.WATCHDOG_PID;
  }
  const child = spawn(process.execPath, [startWeb], {
    cwd: portalRoot,
    env: childEnv,
    stdio: "inherit",
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  let childExited = false;
  let serviceFailed = false;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      childExited = true;
      resolve({ code, signal });
    });
  });
  try {
    if (notifier) {
      const port = positiveSetting("PORT", 3801);
      if (port > 65_535) throw new Error("portal_hosted_invalid_port");
      const healthPath = process.env.PORTAL_HEALTH_PATH?.trim() || "/";
      if (!healthPath.startsWith("/") || /[\0\r\n]/.test(healthPath)) throw new Error("portal_hosted_invalid_health_path");
      const healthUrl = `http://127.0.0.1:${port}${healthPath}`;
      const requestTimeout = positiveSetting("PORTAL_READINESS_REQUEST_TIMEOUT_MS", 5_000);
      const probe = async () => {
        try {
          const response = await fetch(healthUrl, { signal: AbortSignal.timeout(requestTimeout), cache: "no-store" });
          void response.body?.cancel().catch(() => {});
          return response.ok;
        } catch { return false; }
      };
      const failService = (reason: string) => {
        if (serviceFailed) return;
        serviceFailed = true;
        console.error(`portal_hosted_supervision_failed:${reason}`);
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        killTimer.unref();
      };
      const deadline = Date.now() + positiveSetting("PORTAL_READINESS_TIMEOUT_MS", 60_000);
      const interval = positiveSetting("PORTAL_READINESS_INTERVAL_MS", 500);
      let ready = false;
      while (!childExited && Date.now() <= deadline) {
        if (await probe()) { ready = true; break; }
        await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, interval))]);
      }
      if (!ready) failService("startup-timeout");
      else {
        await notifier.notify(`READY=1\nSTATUS=Portal HTTP ready at ${healthUrl}`);
        const watchdogUsec = process.env.WATCHDOG_USEC ? positiveSetting("WATCHDOG_USEC", 0) : 0;
        if (watchdogUsec > 0) {
          const watchdogInterval = positiveSetting("PORTAL_WATCHDOG_INTERVAL_MS", Math.max(250, Math.floor(watchdogUsec / 3_000)));
          const failureLimit = positiveSetting("PORTAL_WATCHDOG_PROBE_FAILURES", 3);
          let probing = false;
          let failures = 0;
          const check = async () => {
            if (probing || serviceFailed || childExited) return;
            probing = true;
            try {
              if (!(await probe())) {
                if (++failures >= failureLimit) failService("steady-state-probe");
                return;
              }
              failures = 0;
              await notifier.notify(`WATCHDOG=1\nSTATUS=Portal HTTP healthy at ${healthUrl}`);
            } catch (error) {
              console.warn(`portal_hosted_notification_failed:${error instanceof Error ? error.message : "unknown"}`);
            } finally { probing = false; }
          };
          await check();
          if (!serviceFailed) watchdogTimer = setInterval(() => void check(), watchdogInterval);
        }
      }
    }
    const exit = await childExit;
    process.exitCode = serviceFailed || exit.signal ? 1 : (exit.code ?? 1);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  } finally {
    if (watchdogTimer) clearInterval(watchdogTimer);
    notifier?.close();
  }
}

if (process.argv[1]?.endsWith("portal-hosted-launcher.ts") || process.argv[1]?.endsWith("cloud-portal-launcher.ts")) {
  main().catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "unknown";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

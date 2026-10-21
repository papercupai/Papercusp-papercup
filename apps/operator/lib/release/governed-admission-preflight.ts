/**
 * WI-6554700010018689: governed-admission preflight for the green-checkpoint.
 *
 * Every affected-test task the gate spawns is admitted through the resource governor, and
 * that admission writes to Postgres through its own dedicated client (operator-core
 * `resource-governor/execution.ts`, `governedProcessClientOptions`). The suite env is a
 * DSN-free allowlist, so the gate hands that client ONE explicit target
 * (`PAPERCUSP_GOVERNED_ADMISSION_DATABASE_URL`, set by `buildGreenCheckpointEnv`).
 *
 * When that target is wrong, nothing fails until the suite starts: run 63b14b89
 * (2026-10-21) materialized the tree, spent its pc-heavy exclusive drain, then had every
 * affected-test task refused admission with 28P01, ~55 minutes in, judging zero tests.
 * This module answers the same question in seconds, before any of that is paid: does the
 * admission target the suite will receive answer `select 1`?
 *
 * Deliberately PURE (the probe is injected) and NEVER throws: the caller turns a refusal
 * into a no-verdict `infra-inconclusive` result, and a broken preflight must not wedge
 * the gate.
 *
 * Scope limit, stated so nobody over-reads a pass: when the gate process itself carries no
 * operator DSN (`gateOperatorPgEnv` returns `{}`), no admission target is set and the child
 * resolves its own through `adminUrl()` (its env, its discovery file). That resolution
 * reads `process.env` directly and cannot be reproduced faithfully in-process, so the
 * preflight reports `probed: false` and lets the run continue: refusing there would
 * permanently wedge every install whose gate runs DSN-free and admits fine today. The run
 * log's `database: <unset> (source=none)` line already flags that mode.
 */

export type GovernedAdmissionPreflightReason =
  /** 28P01 / 28000: the target refused the credentials. Does not self-clear. */
  | "admission-target-auth"
  /** Connection refused, unresolvable host, or no answer within the deadline. */
  | "admission-target-unreachable"
  /** Any other failure of the probe (e.g. 3D000 database does not exist). */
  | "admission-target-error";

export type GovernedAdmissionPreflightResult =
  | { ok: true; probed: true; target: string; summary: string }
  | { ok: true; probed: false; target: null; summary: string }
  | {
      ok: false;
      reason: GovernedAdmissionPreflightReason;
      /** Redacted `user@host:port/db`; never carries the password. */
      target: string;
      /** The probe error's code (`28P01`, `ECONNREFUSED`, `PREFLIGHT_TIMEOUT`, …), if any. */
      code: string | null;
      summary: string;
    };

/** Opens a client to `url`, runs `select 1`, closes it. Rejects on any failure. */
export type GovernedAdmissionProbe = (url: string) => Promise<void>;

/** Long enough for a loaded box to answer a TCP connect + auth, short enough that a dead
 *  target costs seconds rather than the suite's ~55 minutes. */
export const GOVERNED_ADMISSION_PREFLIGHT_TIMEOUT_MS = 15_000;

const AUTH_CODES = new Set(["28P01", "28000"]);
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "PREFLIGHT_TIMEOUT",
]);

/** `user@host:port/db`. The password never appears, even when the URL carries one. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${decodeURIComponent(parsed.username)}@` : "";
    const port = parsed.port || "5432";
    return `${user}${parsed.hostname}:${port}${parsed.pathname}`;
  } catch {
    return "<unparseable database url>";
  }
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
}

export function classifyGovernedAdmissionProbeError(
  error: unknown,
): GovernedAdmissionPreflightReason {
  const code = errorCode(error);
  if (code && AUTH_CODES.has(code)) return "admission-target-auth";
  if (code && UNREACHABLE_CODES.has(code)) return "admission-target-unreachable";
  return "admission-target-error";
}

/** The error text with every occurrence of the raw URL and its password removed. */
function scrubbedMessage(error: unknown, url: string): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [url];
  try {
    const password = new URL(url).password;
    if (password) secrets.push(password, decodeURIComponent(password));
  } catch {
    // An unparseable URL has no separable password; the whole URL is still scrubbed.
  }
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("***");
  }
  return message;
}

export async function preflightGovernedAdmissionTarget(
  url: string | null | undefined,
  probe: GovernedAdmissionProbe,
  opts: { timeoutMs?: number } = {},
): Promise<GovernedAdmissionPreflightResult> {
  const target = url?.trim();
  if (!target) {
    return {
      ok: true,
      probed: false,
      target: null,
      summary:
        "governed-admission preflight: NOT probed. The gate process carries no operator DSN, so no " +
        "admission target is set and the suite's admission client resolves its own (see the run " +
        "log's `database:` line, source=none). A wrong target in this mode still surfaces only " +
        "inside the suite.",
    };
  }
  const shown = redactDatabaseUrl(target);
  const timeoutMs = opts.timeoutMs ?? GOVERNED_ADMISSION_PREFLIGHT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probing: Promise<void>;
  try {
    probing = probe(target);
  } catch (error) {
    probing = Promise.reject(error);
  }
  // A probe that loses the race to the deadline may still reject later; that rejection is
  // already accounted for by the timeout, and must not surface as an unhandled rejection.
  probing.catch(() => {});
  try {
    await Promise.race([
      probing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error(`no answer within ${timeoutMs}ms`), {
                code: "PREFLIGHT_TIMEOUT",
              }),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    return {
      ok: true,
      probed: true,
      target: shown,
      summary: `governed-admission preflight: ${shown} answered select 1`,
    };
  } catch (error) {
    const reason = classifyGovernedAdmissionProbeError(error);
    const code = errorCode(error);
    return {
      ok: false,
      reason,
      target: shown,
      code,
      summary:
        `governed-admission preflight REFUSED (${reason}): the suite's admission target ${shown} ` +
        `failed select 1${code ? ` [${code}]` : ""}: ${scrubbedMessage(error, target)}. Every ` +
        "affected-test task would be refused admission, so this run renders NO verdict instead " +
        "of spending the suite. Fix the gate's operator DSN (HARNESS_ADMIN_DATABASE_URL / " +
        "HARNESS_DATABASE_URL / DATABASE_URL in the checkpoint unit's env); do not triage the " +
        "candidate's files.",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

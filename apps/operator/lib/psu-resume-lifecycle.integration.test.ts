// @vitest-environment node
/**
 * Shared psu resume lifecycle matrix against real Postgres.
 *
 * This is the transport/store seam the unit suites cannot prove: the real
 * launcher reporters replay stable keys through injected proxy/timeout faults,
 * while the real adv-session store commits the lifecycle transitions. No real
 * Claude/OMP/Codex process is spawned; backend parity here means the common
 * tracked-session protocol is driven for each backend while its persisted
 * native identity, cwd, and on-disk config/transcript marker remain untouched.
 *
 * Actual proxy reserved-slice saturation is covered by mcp-proxy/proxy.test.ts;
 * this file consumes the 429 that surface returns and proves the downstream
 * reporter/store handoff stays lossless.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import type {} from "@papercusp/test-config";
import postgres from "postgres";
import {
  acquireBaselineSchemaMutex,
  releaseBaselineSchemaMutex,
} from "@papercusp/test-config/baseline-schema-mutex";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { makeDelivery } from "../../../packages/operator-core/test/_multi-session-testbed";

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock("@papercusp/db-org", async (orig) => {
  const actual =
    await vi.importActual<typeof import("@papercusp/db-org")>(
      "@papercusp/db-org",
    );
  return {
    ...(await orig<typeof import("@papercusp/db-org")>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
  };
});
vi.mock("@papercusp/operator-core/lib/workspace-registry", async (orig) => ({
  ...(await orig<typeof import("@papercusp/operator-core/lib/workspace-registry")>()),
  activeWorkspaceId: () => WS,
}));

import {
  pendingSessionEndWitnessPath,
  reportSessionEnded,
  reportSessionResumed,
  reportSessionResumeFinalized,
  reportSessionResumeReleased,
} from "../scripts/psu-launcher.mjs";

const {
  acquireAdvSessionResume,
  finalizeAdvSessionResume,
  releaseAdvSessionResume,
  retireAdvSessionsByOwner,
  claimAdvSessionResume,
  reactivateAdvSessionByOwner,
  getAdvSession,
  latestAdvSessionByCoordOwner,
} = await import("@papercusp/operator-core/lib/adv-sessions");

const WS = `resume-lifecycle-it-${randomBytes(6).toString("hex")}`;
const homes = new Set<string>();

// Namespacing our own rows by workspace is NOT sufficient isolation on its own:
// operator-core's adv-sessions integration files wipe this same shared table
// UNQUALIFIED (`TRUNCATE harness_shared.adv_sessions`) from a separate Vitest
// process against the same `.withReuse()`d container, which annihilates our
// workspace-scoped rows mid-test. Hold the shared baseline-schema mutex for the
// lifetime of this file so we are serialized against those writers.
let lockClient: postgres.Sql | undefined;

beforeAll(async () => {
  lockClient = await acquireBaselineSchemaMutex(inject("baselineSchemaDsn"), {
    label: "psu-resume-lifecycle.integration.test.ts",
  });
  h.sql = postgres(inject("baselineSchemaDsn"), { max: 4, onnotice: () => {}, connection: { application_name: WS } });
});
afterEach(async () => {
  await h.sql`DELETE FROM harness_shared.agent_launch_idempotency WHERE workspace_id = ${WS}`;
  await h.sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS}`;
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.clear();
});
afterAll(async () => {
  if (h.sql) await h.sql.end({ timeout: 5 });
  if (lockClient) await releaseBaselineSchemaMutex(lockClient);
});

type Agent = "claude" | "omp" | "codex";

async function seedLive(agent: Agent) {
  const suffix = randomBytes(4).toString("hex");
  const coordOwnerId = `su-resume-${agent}-${suffix}`;
  const sessionId = `native-${agent}-${suffix}`;
  const cwd = `/tmp/resume-lifecycle-${agent}-${suffix}`;
  const [row] = await h.sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, cwd, started_at)
    VALUES (${WS}, ${agent}, ${agent === "omp" ? "omp" : "console"},
            ${coordOwnerId}, ${sessionId}, ${cwd}, now() - interval '10 minutes')
    RETURNING id`;
  const id = Number(row.id);

  const home = mkdtempSync(join(tmpdir(), `psu-resume-${agent}-`));
  homes.add(home);
  const root =
    agent === "claude"
      ? join(home, ".papercusp", "su-claude-homes", coordOwnerId)
      : join(home, ".papercusp", `su-${agent}-homes`, `session-${id}`);
  const marker = join(
    root,
    agent === "codex" ? "sessions" : "projects",
    "transcript.marker",
  );
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, `UNCHANGED:${agent}:${sessionId}\n`);
  return { id, coordOwnerId, sessionId, cwd, home, root, marker };
}

function timeoutAfterCommit(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function makeLifecycleFetch(faults: {
  end429?: boolean;
  acquireTimeoutAfterCommit?: boolean;
  finalizeTimeoutAfterCommit?: boolean;
}) {
  const calls = { ended: 0, acquired: 0, finalized: 0, released: 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      advSessionId: number;
      exitCode?: number | null;
      killedBySignal?: string | null;
      launchFailed?: boolean;
      endAttemptKey?: string;
      resumeClaimKey?: string;
      launchArgv?: string[];
      allowRetired?: boolean;
    };

    if (path.endsWith("/session-ended")) {
      calls.ended += 1;
      if (faults.end429 && calls.ended === 1) {
        return new Response(JSON.stringify({ error: "mcp_proxy_overloaded" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "2" },
        });
      }
      const endedBy = body.launchFailed
        ? "cleanup"
        : body.killedBySignal
          ? "signal"
          : "self";
      await h.sql`
        UPDATE harness_shared.adv_sessions
           SET ended_at = now(), exit_code = ${body.exitCode ?? null}, ended_by = ${endedBy},
               ended_signal = ${body.killedBySignal ?? null},
               resume_claim_key = NULL, resume_claimed_at = NULL
         WHERE id = ${body.advSessionId}`;
      return Response.json({
        ok: true,
        ended: true,
        endAttemptKey: body.endAttemptKey,
      });
    }

    if (path.endsWith("/session-resumed")) {
      calls.acquired += 1;
      const reservation = await acquireAdvSessionResume(
        body.advSessionId,
        body.resumeClaimKey ?? "",
        undefined,
        undefined,
        undefined,
        body.allowRetired === true,
      );
      if (faults.acquireTimeoutAfterCommit && calls.acquired === 1) {
        throw timeoutAfterCommit("acquire response lost after commit");
      }
      return Response.json({
        ok: true,
        ...reservation,
        reactivated: reservation.acquired,
      });
    }

    if (path.endsWith("/session-resume-finalized")) {
      calls.finalized += 1;
      const finalized = await finalizeAdvSessionResume(
        body.advSessionId,
        body.resumeClaimKey ?? "",
        body.launchArgv,
        body.allowRetired === true,
      );
      if (faults.finalizeTimeoutAfterCommit && calls.finalized === 1) {
        throw timeoutAfterCommit("finalize response lost after commit");
      }
      return Response.json({
        ok: true,
        finalized,
        resumeClaimKey: body.resumeClaimKey,
      });
    }

    if (path.endsWith("/session-resume-released")) {
      calls.released += 1;
      const released = await releaseAdvSessionResume(
        body.advSessionId,
        body.resumeClaimKey ?? "",
      );
      return Response.json({
        ok: true,
        released,
        resumeClaimKey: body.resumeClaimKey,
      });
    }

    return Response.json(
      { ok: false, error: `unexpected lifecycle path ${path}` },
      { status: 404 },
    );
  };
  return { calls, fetchImpl };
}

async function readLifecycleRow(id: number) {
  const [row] = await h.sql<
    Array<{
      ended_at: Date | null;
      exit_code: number | null;
      ended_by: string | null;
      resume_claim_key: string | null;
      resume_claimed_at: Date | null;
      session_id: string;
      cwd: string;
      launch_argv: string[] | null;
      retired_at: Date | null;
      retired_by: string | null;
      retired_reason: string | null;
    }>
  >`
    SELECT ended_at, exit_code, ended_by, resume_claim_key, resume_claimed_at,
           session_id, cwd, launch_argv, retired_at, retired_by, retired_reason
      FROM harness_shared.adv_sessions
     WHERE id = ${id}`;
  return row;
}

describe("psu resume lifecycle lossless handoff (real launcher reporters + real PG)", () => {
  it("a real headless process kill persists retirement and drops a later inbox wake without spawning", async () => {
    const { killOne } = await import("@papercusp/operator-core/lib/agent-tools/fleet/kill");
    const { executeWake } = await import("@papercusp/operator-core/lib/events/await/wake-executor");
    const seeded = await seedLive("claude");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const exited = once(child, "close");
    const audit: string[] = [];
    const spawnDetached = vi.fn(() => { throw new Error("retired owner must never spawn"); });
    const claimResume = vi.fn(claimAdvSessionResume);
    try {
      const killed = await killOne({ actor: "test-operator", target: seeded.coordOwnerId, closeTerminal: false, reason: "retirement regression" }, {
        retireOwner: retireAdvSessionsByOwner,
        findHost: async () => ({ ownerId: seeded.coordOwnerId, advSessionId: String(seeded.id), pid: child.pid!, ptyPid: child.pid!, sock: "/tmp/private-fixture.sock", command: "psu", startedAt: Date.now(), bridgeTty: false }) as never,
        markSessionEnded: async (id, signal) => {
          await h.sql`UPDATE harness_shared.adv_sessions SET ended_at = now(), ended_by = 'signal', ended_signal = ${signal} WHERE id = ${Number(id)}`;
        },
        audit: async (action) => { audit.push(action); },
      });
      expect(killed).toMatchObject({ ok: true, kind: "headless", killed: true, signal: "SIGTERM" });
      expect(await exited).toEqual([null, "SIGTERM"]);
      expect(audit).toContain("fleet.kill_headless");
      const row = await getAdvSession(seeded.id);
      expect(row).toMatchObject({ retiredBy: "fleet:kill:test-operator", endedBy: "signal" });
      const delivery = makeDelivery({ workspaceId: WS, subscriberId: seeded.coordOwnerId, createdAt: new Date().toISOString(), wakeHandle: {
        kind: "adv-session", advSessionId: seeded.id, agent: "claude", sessionId: seeded.sessionId, ompThreadId: null, cwd: seeded.cwd, pid: child.pid!,
      } });
      const result = await executeWake(delivery, {
        getSession: getAdvSession,
        getLatestSessionForOwner: latestAdvSessionByCoordOwner,
        findPsuHost: async () => null,
        getSessionLifecycle: async () => ({}) as never,
        presence: async () => null,
        findPty: () => null,
        spawnDetached,
        claimResume,
      });
      expect(result).toMatchObject({ kind: "drop", reason: expect.stringContaining("owner retired by deliberate kill") });
      expect(spawnDetached).not.toHaveBeenCalled();
      expect(claimResume).not.toHaveBeenCalled();
      expect(await getAdvSession(seeded.id)).toEqual(row);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }, 60_000);

  it.each(["claude", "omp", "codex"] as const)(
    "%s retirement fences every owner registration and every routine reactivation path",
    async (agent) => {
      const seeded = await seedLive(agent);
      const [older] = await h.sql<Array<{ id: string }>>`
        INSERT INTO harness_shared.adv_sessions
          (workspace_id, agent, mode, coord_owner_id, session_id, cwd, started_at)
        VALUES (${WS}, ${agent}, 'console', ${seeded.coordOwnerId}, 'other-native',
                ${seeded.cwd}, now() - interval '1 hour') RETURNING id`;
      await retireAdvSessionsByOwner(seeded.coordOwnerId, "test-operator", "replace member");
      const before = await readLifecycleRow(seeded.id);
      expect(before).toMatchObject({ retired_by: "fleet:kill:test-operator", retired_reason: "replace member" });
      expect(before.retired_at).not.toBeNull();
      for (const id of [seeded.id, Number(older.id)]) {
        expect((await readLifecycleRow(id)).retired_at).not.toBeNull();
        await expect(acquireAdvSessionResume(id, `auto-${id}`)).resolves.toEqual({ status: "retired", acquired: false });
      }
      // The newest registration is also fenced for both legacy protocols.
      await expect(claimAdvSessionResume(Number(older.id))).resolves.toBe("retired");
      await expect(claimAdvSessionResume(Number(older.id), "keyed-wake")).resolves.toBe("retired");
      await expect(reactivateAdvSessionByOwner(seeded.coordOwnerId)).resolves.toBe(false);
      expect(await readLifecycleRow(seeded.id)).toEqual(before);
    },
  );

  it.each(["claude", "omp", "codex"] as const)(
    "%s explicit relaunch keeps retirement through failure and clears it only on successful keyed finalization",
    async (agent) => {
      const seeded = await seedLive(agent);
      await reportSessionEnded(seeded.id, 130, { fetchImpl: makeLifecycleFetch({}).fetchImpl, operatorUrl: "http://operator.test", token: "test" });
      await retireAdvSessionsByOwner(seeded.coordOwnerId, "test-operator", "replace member");
      const retired = await readLifecycleRow(seeded.id);
      const transport = makeLifecycleFetch({});
      const common = { fetchImpl: transport.fetchImpl, operatorUrl: "http://operator.test", token: "test" };
      await expect(reportSessionResumed(seeded.id, { ...common, resumeClaimKey: "automatic" })).resolves.toMatchObject({ claimed: false, status: "retired" });
      await expect(reportSessionResumed(seeded.id, { ...common, resumeClaimKey: "failed-explicit", allowRetired: true })).resolves.toMatchObject({ claimed: true });
      expect((await readLifecycleRow(seeded.id)).retired_at).toEqual(retired.retired_at);
      await expect(reportSessionResumeReleased(seeded.id, "failed-explicit", common)).resolves.toMatchObject({ released: true });
      expect(await readLifecycleRow(seeded.id)).toEqual(retired);
      await expect(reportSessionResumed(seeded.id, { ...common, resumeClaimKey: "successful-explicit", allowRetired: true })).resolves.toMatchObject({ claimed: true });
      const launchArgv = ["psu", `--resume=${seeded.id}`, `--agent=${agent}`];
      await expect(reportSessionResumeFinalized(seeded.id, "successful-explicit", { ...common, allowRetired: true, launchArgv })).resolves.toMatchObject({ finalized: true });
      expect(await readLifecycleRow(seeded.id)).toMatchObject({ retired_at: null, retired_by: null, retired_reason: null, ended_at: null, ended_by: null, resume_claim_key: null, launch_argv: launchArgv, session_id: seeded.sessionId, cwd: seeded.cwd });
      expect(readFileSync(seeded.marker, "utf8")).toContain(seeded.sessionId);
    },
  );

  it("a kill invalidates an acquired explicit key and a previously successful legacy replay", async () => {
    const seeded = await seedLive("codex");
    await expect(claimAdvSessionResume(seeded.id, "old-success")).resolves.toBe(true);
    await h.sql`UPDATE harness_shared.adv_sessions SET ended_at = now(), ended_by = 'signal' WHERE id = ${seeded.id}`;
    await expect(acquireAdvSessionResume(seeded.id, "prepared-explicit", undefined, undefined, undefined, true)).resolves.toMatchObject({ acquired: true });
    await retireAdvSessionsByOwner(seeded.coordOwnerId, "operator", "kill while prepared");
    await expect(finalizeAdvSessionResume(seeded.id, "prepared-explicit", undefined, true)).resolves.toBe(false);
    await expect(claimAdvSessionResume(seeded.id, "old-success")).resolves.toBe("retired");
    expect(await readLifecycleRow(seeded.id)).toMatchObject({ ended_by: "signal", retired_by: "fleet:kill:operator", resume_claim_key: null });
  });

  it("retire and acquire serialize without leaving a finalizable reservation", async () => {
    const seeded = await seedLive("codex");
    await Promise.all([
      acquireAdvSessionResume(seeded.id, "racing-wake"),
      retireAdvSessionsByOwner(seeded.coordOwnerId, "operator", "race"),
    ]);
    expect(await readLifecycleRow(seeded.id)).toMatchObject({ retired_by: "fleet:kill:operator", resume_claim_key: null });
    await expect(finalizeAdvSessionResume(seeded.id, "racing-wake")).resolves.toBe(false);
  });

  it("a keyed success replay waits for an in-flight retirement instead of returning its old receipt", async () => {
    const seeded = await seedLive("codex");
    await expect(claimAdvSessionResume(seeded.id, "old-success")).resolves.toBe(true);
    let entered!: () => void;
    let commit!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const canCommit = new Promise<void>((resolve) => { commit = resolve; });
    // Hold the same row UPDATE lock as retireAdvSessionsByOwner, pausing just
    // before commit so the claimant must consult the current retirement value.
    const retirement = h.sql.begin(async (tx) => {
      await tx`UPDATE harness_shared.adv_sessions SET retired_at = now(), retired_by = 'fleet:kill:race' WHERE id = ${seeded.id}`;
      entered();
      await canCommit;
    });
    await locked;
    let settled = false;
    const replay = claimAdvSessionResume(seeded.id, "old-success").finally(() => { settled = true; });
    try {
      await vi.waitFor(async () => {
        const waiters = await h.sql<Array<{ count: string }>>`
          SELECT count(*) FROM pg_stat_activity
           WHERE application_name = ${WS} AND wait_event_type = 'Lock'`;
        expect(settled || Number(waiters[0].count) > 0).toBe(true);
      }, { timeout: 5_000, interval: 10 });
    } finally {
      commit();
      await retirement;
    }
    await expect(replay).resolves.toBe("retired");
    expect((await readLifecycleRow(seeded.id)).retired_by).toBe("fleet:kill:race");
  });

  it.each(["claude", "omp", "codex"] as const)(
    "%s signal exit remains automatically resumable without deliberate retirement",
    async (agent) => {
      const seeded = await seedLive(agent);
      const transport = makeLifecycleFetch({});
      const common = { fetchImpl: transport.fetchImpl, operatorUrl: "http://operator.test", token: "test" };
      await expect(reportSessionEnded(seeded.id, 143, { ...common, killedBySignal: "SIGTERM" })).resolves.toMatchObject({ reported: true });
      expect(await readLifecycleRow(seeded.id)).toMatchObject({ ended_by: "signal", retired_at: null });
      await expect(reportSessionResumed(seeded.id, { ...common, resumeClaimKey: "crash-recovery" })).resolves.toMatchObject({ claimed: true });
      await expect(reportSessionResumeFinalized(seeded.id, "crash-recovery", common)).resolves.toMatchObject({ finalized: true });
      expect(await readLifecycleRow(seeded.id)).toMatchObject({ ended_at: null, ended_by: null, retired_at: null });
    },
  );

  it.each(["claude", "omp", "codex"] as const)(
    "%s survives end 429 + acquire/finalize timeout-after-commit without a ghost or five-minute lockout",
    async (agent) => {
      const seeded = await seedLive(agent);
      const transport = makeLifecycleFetch({
        end429: true,
        acquireTimeoutAfterCommit: true,
        finalizeTimeoutAfterCommit: true,
      });
      let clock = 0;
      const resilience = {
        fetchImpl: transport.fetchImpl,
        operatorUrl: "http://operator.test",
        token: "integration-token",
        connectBudgetMs: 0,
        timeoutRetries: 1,
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
        onNotice: () => {},
      };

      await expect(
        reportSessionEnded(seeded.id, 130, {
          ...resilience,
          home: seeded.home,
          endAttemptKey: `end-${agent}-${seeded.id}`,
        }),
      ).resolves.toMatchObject({ reported: true });
      expect(transport.calls.ended).toBe(2);
      expect(
        existsSync(pendingSessionEndWitnessPath(seeded.id, seeded.home)),
      ).toBe(false);

      const resumeClaimKey = `resume-${agent}-${seeded.id}`;
      const acquired = await reportSessionResumed(seeded.id, {
        ...resilience,
        resumeClaimKey,
      });
      expect(acquired).toMatchObject({
        claimed: true,
        status: "acquired",
        resumeClaimKey,
        replayed: true,
      });
      expect(transport.calls.acquired).toBe(2);

      const launchArgv = [
        "psu",
        "--no-picker",
        `--resume=${seeded.id}`,
        `--agent=${agent}`,
        "--account=auto",
        "--model=resume-regression:max",
      ];
      await expect(
        reportSessionResumeFinalized(seeded.id, resumeClaimKey, {
          ...resilience,
          launchArgv,
        }),
      ).resolves.toEqual({ finalized: true, resumeClaimKey });
      expect(transport.calls.finalized).toBe(2);

      expect(await readLifecycleRow(seeded.id)).toMatchObject({
        ended_at: null,
        exit_code: null,
        ended_by: null,
        resume_claim_key: null,
        resume_claimed_at: null,
        session_id: seeded.sessionId,
        cwd: seeded.cwd,
        launch_argv: launchArgv,
      });
      expect(readFileSync(seeded.marker, "utf8")).toBe(
        `UNCHANGED:${agent}:${seeded.sessionId}\n`,
      );
    },
  );

  it.each(["claude", "omp", "codex"] as const)(
    "%s crash-before-spawn release is replay-safe and immediately admits recovery",
    async (agent) => {
      const seeded = await seedLive(agent);
      await h.sql`
        UPDATE harness_shared.adv_sessions
           SET ended_at = now(), exit_code = 130, ended_by = 'self'
         WHERE id = ${seeded.id}`;
      const transport = makeLifecycleFetch({});
      const common = {
        fetchImpl: transport.fetchImpl,
        operatorUrl: "http://operator.test",
        token: "integration-token",
      };
      const crashedKey = `crashed-${agent}-${seeded.id}`;
      await expect(
        reportSessionResumed(seeded.id, {
          ...common,
          resumeClaimKey: crashedKey,
        }),
      ).resolves.toMatchObject({ claimed: true, resumeClaimKey: crashedKey });
      await expect(
        reportSessionResumeReleased(seeded.id, crashedKey, common),
      ).resolves.toEqual({ released: true, resumeClaimKey: crashedKey });
      await expect(
        reportSessionResumeReleased(seeded.id, crashedKey, common),
      ).resolves.toEqual({ released: true, resumeClaimKey: crashedKey });

      const recoveryKey = `${crashedKey}-recovery`;
      await expect(
        reportSessionResumed(seeded.id, {
          ...common,
          resumeClaimKey: recoveryKey,
        }),
      ).resolves.toMatchObject({ claimed: true, resumeClaimKey: recoveryKey });
      expect(await readLifecycleRow(seeded.id)).toMatchObject({
        ended_by: "self",
        resume_claim_key: recoveryKey,
        session_id: seeded.sessionId,
        cwd: seeded.cwd,
      });
      expect(readFileSync(seeded.marker, "utf8")).toContain(seeded.sessionId);
    },
  );
});

/**
 * psu --resume onto a different backend — the tree half of acceptance bar R-10
 * (plan consult-backed-parking-2026-10-12, P-010 / P-011, D-009).
 *
 * R-10 is proven LIVE (the P-013 staging matrix cites a delivered session_ports
 * row and the target CLI's native transcript per pair). This file pins the
 * launcher decisions that come before any port is prepared: which backends the
 * interactive picker offers, and that every ordered cross-backend pair resolves
 * to a session port rather than a refusal.
 *
 * Root cause pinned here: chooseResumeTarget built its picker with
 * `session.agent === "claude" ? AGENTS : [session.agent]`, so a Codex or OMP
 * session was never offered another backend even though the session-port
 * service prepares claude, codex and omp sources alike.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENTS,
  chooseResumeTarget,
  resolveResumeTarget,
  resumePickerBackendsFor,
  unresumableSourceCause,
} from "../scripts/psu-launcher.mjs";

const BACKENDS = ["claude", "codex", "omp"] as const;
type Backend = (typeof BACKENDS)[number];

function trackedSession(agent: Backend | undefined) {
  return {
    id: 42,
    sessionId: "bb06937a-2054-4f27-945b-225b84dc3ccb",
    agent,
    role: null,
    workspaceId: "papercusp-workspace",
    coordOwnerId: "su-source-owner",
    cwd: "/repo",
    planSlug: "the-plan",
  };
}

const CROSS_PAIRS: Array<[Backend, Backend]> = BACKENDS.flatMap((source) =>
  BACKENDS.filter((target) => target !== source).map(
    (target) => [source, target] as [Backend, Backend],
  ),
);

describe("psu --resume cross-backend target resolution (R-10)", () => {
  it("covers exactly the six ordered pairs among the launcher's backends", () => {
    expect([...AGENTS].sort()).toEqual([...BACKENDS].sort());
    expect(CROSS_PAIRS).toHaveLength(6);
  });

  it.each(BACKENDS)(
    "the interactive picker offers EVERY backend to a %s source, its own first",
    (agent) => {
      const backends = resumePickerBackendsFor(trackedSession(agent));
      expect(backends[0]).toBe(agent);
      expect([...backends].sort()).toEqual([...BACKENDS].sort());
    },
  );

  it.each(CROSS_PAIRS)(
    "a %s source picked onto %s resolves to a session port, never a refusal",
    (sourceAgent, targetAgent) => {
      expect(
        resolveResumeTarget(
          trackedSession(sourceAgent),
          {},
          { targetAgent, modelSpec: null },
        ),
      ).toMatchObject({ operation: "port", sourceAgent, targetAgent });
    },
  );

  it.each(CROSS_PAIRS)(
    "the real %s→%s picker offers selectable target-specific model rows (R-22)",
    async (sourceAgent, targetAgent) => {
      const expectedModel = {
        claude: "fable",
        codex: "gpt-6.1-sol",
        omp: "openai/gpt-6.1-sol",
      }[targetAgent];
      const select = vi.fn(async ({ message, choices }: {
        message: string; choices: Array<{ name: string; value: any }>;
      }) => {
        if (message === "Continue this session with which backend/model?") {
          return choices.find((row) => row.value === "<choose-model>").value;
        }
        if (message === "Reasoning effort") return "high";
        expect(message).toBe("Target backend and model");
        for (const [backend, model] of Object.entries({
          claude: "fable", codex: "gpt-6.1-sol", omp: "openai/gpt-6.1-sol",
        })) {
          expect(choices).toContainEqual(expect.objectContaining({
            value: expect.objectContaining({ kind: "model", targetAgent: backend, model }),
          }));
        }
        const row = choices.find((row) => row.value.kind === "model" &&
          row.value.targetAgent === targetAgent && row.value.model === expectedModel);
        expect(row).toBeDefined();
        expect(row.name).toContain(`Port to ${targetAgent}`);
        return row.value;
      });
      const readCodexModels = vi.fn(() => [{
        id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["high"],
      }]);
      const readOmpModels = vi.fn(async () => [{
        selector: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", thinking: ["high"],
      }]);
      const target = await chooseResumeTarget(trackedSession(sourceAgent), { picker: true }, {
        prompts: { select, input: vi.fn(), search: vi.fn() },
        readLastActiveModel: () => null,
        fetchPortCapabilities: async () => null,
        readCodexModels,
        readOmpModels,
      });
      expect(readCodexModels).toHaveBeenCalledOnce();
      expect(readOmpModels).toHaveBeenCalledOnce();
      expect(target).toMatchObject({
        operation: "port", sourceAgent, targetAgent,
        modelSpec: expect.stringContaining(expectedModel),
      });
      expect(select).toHaveBeenCalledTimes(3);
    },
  );

  it.each(CROSS_PAIRS)(
    "a scripted %s resume with --agent=%s also resolves to a session port",
    (sourceAgent, targetAgent) => {
      // Unattended Codex launches must name their model (CodexModelPolicyError
      // otherwise — see the control below), so the scripted Codex leg passes one.
      const model = targetAgent === "codex" ? "sol:high" : undefined;
      expect(
        resolveResumeTarget(trackedSession(sourceAgent), {
          agent: targetAgent,
          picker: false,
          ...(model ? { model } : {}),
        }),
      ).toMatchObject({ operation: "port", sourceAgent, targetAgent });
    },
  );

  it.each(["claude", "omp"] as const)(
    "CONTROL: a scripted %s→codex resume with no model is refused with its cause before any port is prepared",
    (sourceAgent) => {
      expect(() =>
        resolveResumeTarget(trackedSession(sourceAgent), {
          agent: "codex",
          picker: false,
        }),
      ).toThrow(/Codex model is required/);
    },
  );

  it.each(BACKENDS)(
    "CONTROL: a %s source kept on its own backend stays a native resume",
    (agent) => {
      expect(
        resolveResumeTarget(
          trackedSession(agent),
          {},
          { targetAgent: agent, modelSpec: null },
        ),
      ).toMatchObject({ operation: "native", sourceAgent: agent, targetAgent: agent });
    },
  );

  it("CONTROL: an unknown source backend still gets the full list, never an empty menu", () => {
    expect([...resumePickerBackendsFor(trackedSession(undefined))].sort()).toEqual(
      [...BACKENDS].sort(),
    );
  });
});

/**
 * R-23: a SINGLE session that cannot be resumed is refused with its cause
 * before the target is spawned. launchResolvedResume calls
 * unresumableSourceCause right after the target is resolved and BEFORE
 * ensureBackendInstalled / chooseResumeAccount / launchSessionPort, so a
 * non-null cause here is a refusal with nothing spawned. Per D-009 the refusal
 * is per session, never per backend pair: the OMP source with a transcript must
 * pass.
 */
describe("psu --resume refuses an unresumable source before spawn (R-23)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempHome = () => {
    const dir = mkdtempSync(join(tmpdir(), "psu-resume-r23-"));
    dirs.push(dir);
    return dir;
  };
  const OMP_THREAD = "0d1e2f3a4b5c";
  const ompSource = (agentHome: string) => ({
    ...trackedSession("omp"),
    ompThreadId: OMP_THREAD,
    agentHome,
  });
  const port = (sourceAgent: Backend, targetAgent: Backend) =>
    resolveResumeTarget(
      trackedSession(sourceAgent),
      {},
      { targetAgent, modelSpec: null },
    );

  it("refuses an untracked (raw native) session and names the cause", () => {
    const cause = unresumableSourceCause(ompSource(tempHome()), port("omp", "claude"), {
      tracked: false,
      home: tempHome(),
    });
    expect(cause).toMatch(/requires a psu-tracked source session/);
    expect(cause).toContain(`omp session ${OMP_THREAD}`);
  });

  it.each(["claude", "codex"] as const)(
    "refuses a tracked OMP source whose transcript is missing (onto %s), naming the session and target",
    (targetAgent) => {
      const agentHome = tempHome();
      mkdirSync(join(agentHome, "sessions"), { recursive: true });
      const cause = unresumableSourceCause(ompSource(agentHome), port("omp", targetAgent), {
        tracked: true,
        home: tempHome(),
      });
      expect(cause).toMatch(/no source transcript to carry onto/);
      expect(cause).toContain(`omp session ${OMP_THREAD}`);
      expect(cause).toContain(targetAgent);
    },
  );

  it("refuses a tracked Claude source whose transcript file is missing", () => {
    const home = tempHome();
    const configDir = tempHome();
    const cause = unresumableSourceCause(
      { ...trackedSession("claude"), configDir },
      port("claude", "omp"),
      { tracked: true, home },
    );
    expect(cause).toMatch(/no source transcript to carry onto omp/);
  });

  it.each(["claude", "codex"] as const)(
    "CONTROL: the same tracked OMP source WITH its transcript on disk ports onto %s (no pair refused wholesale)",
    (targetAgent) => {
      const agentHome = tempHome();
      mkdirSync(join(agentHome, "sessions", "--repo--"), { recursive: true });
      writeFileSync(
        join(agentHome, "sessions", "--repo--", `2026-10-12T00-00-00_${OMP_THREAD}.jsonl`),
        '{"type":"session"}\n',
      );
      expect(
        unresumableSourceCause(ompSource(agentHome), port("omp", targetAgent), {
          tracked: true,
          home: tempHome(),
        }),
      ).toBeNull();
    },
  );

  it("CONTROL: a transcript-less source with a recorded session archive is resumable", () => {
    expect(
      unresumableSourceCause(
        { ...trackedSession("claude"), configDir: tempHome(), hasArchive: true },
        port("claude", "codex"),
        { tracked: true, home: tempHome() },
      ),
    ).toBeNull();
  });

  it("CONTROL: a same-backend native resume is not judged by the port refusal", () => {
    expect(
      unresumableSourceCause(
        { ...trackedSession("claude"), configDir: tempHome() },
        port("claude", "claude"),
        { tracked: false, home: tempHome() },
      ),
    ).toBeNull();
  });
});

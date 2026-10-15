// @vitest-environment node
/**
 * PUI resume (consult-backed-parking-2026-10-12 P-012).
 *
 * PUI's ended-session route opens a pane running `psu --resume <adv id>`
 * (apps/tui/src/app.rs resume_spec). That pane is a TTY, so the launcher shows
 * the interactive first-step picker. These tests pin the two launcher halves of
 * the PUI contract:
 *
 *   R-11 — Enter on the default row reopens the session in its ORIGINAL backend
 *          (claude/codex/omp), with its last-active model when one is known.
 *   R-25 — a cross-backend choice that cannot be honoured is refused with its
 *          cause BEFORE any backend is installed, an account is chosen or a
 *          process is spawned. The pane is not close-on-exit (pinned in
 *          app.rs tests), so the refusal stays readable instead of the pane
 *          vanishing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveResumeTarget,
  resumeFirstStepChoices,
  resumeFlow,
} from "../scripts/psu-launcher.mjs";

const BACKENDS = ["claude", "codex", "omp"] as const;
type Backend = (typeof BACKENDS)[number];

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function emptyHome() {
  const h = mkdtempSync(join(tmpdir(), "psu-pui-resume-"));
  homes.push(h);
  return h;
}

function trackedSession(agent: Backend, configDir?: string) {
  return {
    id: 42,
    sessionId: "bb06937a-2054-4f27-945b-225b84dc3ccb",
    agent,
    role: null,
    workspaceId: "papercusp-workspace",
    coordOwnerId: "su-source-owner",
    cwd: "/repo",
    planSlug: "the-plan",
    ...(configDir ? { configDir } : {}),
  };
}

describe("PUI resume picker default (R-11)", () => {
  it.each(BACKENDS)(
    "row 0 for a %s session keeps the original backend and its last-active model",
    (agent) => {
      const rows = resumeFirstStepChoices(trackedSession(agent), "some-model:high");
      expect(rows[0].value).toEqual({ targetAgent: agent, modelSpec: "some-model:high" });
      expect(rows[0].name).toContain(`Native ${agent}`);
    },
  );

  it.each(BACKENDS)(
    "with no known last model, row 0 for a %s session is the native backend default",
    (agent) => {
      const rows = resumeFirstStepChoices(trackedSession(agent), null);
      expect(rows[0].value).toEqual({ targetAgent: agent, modelSpec: null });
    },
  );

  it.each(BACKENDS)(
    "the default row resolves to an in-place resume of the %s session, never a port",
    (agent) => {
      const session = trackedSession(agent);
      const target = resolveResumeTarget(session, {}, resumeFirstStepChoices(session, null)[0].value);
      expect(target.targetAgent).toBe(agent);
      expect(target.operation).not.toBe("port");
    },
  );

  it("the cross-backend escape is the LAST row, so Enter never leaves the original backend", () => {
    for (const last of ["opus", null]) {
      const rows = resumeFirstStepChoices(trackedSession("claude"), last);
      expect(rows.at(-1)?.name).toBe("Choose a different model…");
      expect(rows.slice(0, -1).every((r) => r.value.targetAgent === "claude")).toBe(true);
    }
  });
});

describe("PUI cross-backend resume refusal (R-25)", () => {
  it("a cross-backend pick of an unresumable tracked session is refused with its cause before launch", async () => {
    // A codex source whose random rollout id has no transcript anywhere, ported
    // onto claude (a claude target needs no explicit model; codex does).
    const source = trackedSession("codex", emptyHome());
    const paths: string[] = [];
    const apiImpl = async (path: string) => {
      paths.push(path);
      if (path.startsWith("/api/adv/sessions/resumable")) return { sessions: [source] };
      return {};
    };
    await expect(
      resumeFlow({ resumeId: "42", picker: false, agent: "claude" }, { apiImpl }),
    ).rejects.toThrow(/psu: refusing to resume — .*no source transcript to carry onto claude/);
    // Only the session lookup reached the operator: no port, account or spawn call.
    expect(paths.every((p) => p.startsWith("/api/adv/sessions/resumable"))).toBe(true);
  });

  it("CONTROL: the same scripted pick on the native backend is handed to the launcher, not refused", async () => {
    const source = trackedSession("claude", emptyHome());
    const launched: unknown[] = [];
    await resumeFlow(
      { resumeId: "42", picker: false },
      {
        apiImpl: async (path: string) =>
          path.startsWith("/api/adv/sessions/resumable") ? { sessions: [source] } : {},
        launchResolvedResumeImpl: async (s: unknown) => {
          launched.push(s);
        },
      },
    );
    expect(launched).toHaveLength(1);
  });
});

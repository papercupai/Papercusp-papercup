import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  PINNED_KASMVNC_ARTIFACT,
  WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX,
  WORKSPACE_HOST_DESKTOP_PACK_CHECKS,
  WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION,
} from "./workspace-host-desktop-pack";

import {
  NodeWorkspaceHostSystem,
  WorkspaceHostOperationError,
  WorkspaceHostGitCredentialBindingRegistry,
  WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT,
  WORKSPACE_HOST_RELEASE_BIN_DIR,
  WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE,
  createProductionWorkspaceHostRemoteInitializerDeps,
  workspaceHostGetOnlyGitCredentialEnvironment,
  type WorkspaceHostCommandInput,
  type WorkspaceHostSystem,
} from "./workspace-host-remote-initializer-host";
import {
  WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN,
  WORKSPACE_HOST_DATA_ROOT,
} from "./workspace-host-bootstrap";
import {
  encodeWorkspaceHostAgentHomeBundle,
  workspaceHostAgentHomePaths,
} from "./workspace-host-agent-home";
import {
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
} from "./workspace-host-credential-namespace";
import {
  NodeWorkspaceHostCredentialDeliveryFilesystem,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  WorkspaceHostCredentialGenerationConflictError,
  WorkspaceHostCredentialMaterial,
  executeWorkspaceHostCredentialDelivery,
  parseWorkspaceHostCredentialDeliveryRequest,
  workspaceHostCredentialMaterialPath,
} from "./workspace-host-credential-delivery";
import type {
  WorkspaceHostAgentProbeInvocation,
  WorkspaceHostAgentProbeRunner,
} from "./workspace-host-agent-authentication";

const MATERIAL_ROOT = "/credentials";
const MATERIAL_PATH = workspaceHostCredentialMaterialPath(
  MATERIAL_ROOT,
  "git-short-lived-delegation",
  7,
);
const AUTHORIZATION_MATERIAL =
  "https://git-user:private-token-value@github.com";
const NOW = new Date("2026-08-26T22:00:00.000Z");
const AGENT_FIELDS = { hostId: "host-1", agentSet: "claude-codex-omp" };

class RecordingSystem implements WorkspaceHostSystem {
  readonly commands: WorkspaceHostCommandInput[] = [];
  readonly present = new Set<string>();
  readonly files = new Map<string, Buffer>();
  readonly results = new Map<
    string,
    { exitCode: number; stdout: string; stderr: string }
  >();

  async run(input: WorkspaceHostCommandInput) {
    this.commands.push(input);
    const configured = this.results.get(input.args.join("\u0000"));
    if (configured) return configured;
    if (input.args[0] === "clone") {
      const destination = input.args.at(-1);
      if (destination) {
        this.present.add(destination);
        this.present.add(join(destination, ".git"));
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  setResult(
    args: readonly string[],
    result: { exitCode: number; stdout: string; stderr: string },
  ): void {
    this.results.set(args.join("\u0000"), result);
  }
  /** Which creation form made each directory: the PRIVATE 0700 one or the 0770 workspace one. */
  readonly directoryForms = new Map<string, "private" | "workspace">();
  async ensureDirectory(path: string) {
    this.present.add(path);
    this.directoryForms.set(path, "private");
  }
  async ensureWorkspaceDirectory(path: string) {
    this.present.add(path);
    this.directoryForms.set(path, "workspace");
  }
  async pathExists(path: string) {
    return this.present.has(path);
  }
  async removePath(path: string) {
    this.present.delete(path);
    this.files.delete(path);
  }
  // The credential-delivery half of the seam. Faked here for the same reason the rest is: revoke()
  // writes the revocation ledger through it, and a double that omitted these would fall through to
  // the real filesystem and try to write under the production credential root.
  async writePrivateFile(path: string, bytes: Buffer) {
    this.files.set(path, Buffer.from(bytes));
    this.present.add(path);
  }
  async readFileIfPresent(path: string) {
    return this.files.get(path) ?? null;
  }
}

class PausingRecordingSystem extends RecordingSystem {
  private pausePath: string | null = null;
  private didPause = false;
  private markPaused: (() => void) | undefined;
  private releasePause: (() => void) | undefined;
  readonly paused: Promise<void>;

  constructor() {
    super();
    this.paused = new Promise<void>((resolve) => {
      this.markPaused = resolve;
    });
  }

  pauseRemovalAt(path: string): void {
    this.pausePath = path;
  }

  release(): void {
    this.releasePause?.();
  }

  override async removePath(path: string): Promise<void> {
    if (!this.didPause && path === this.pausePath) {
      this.didPause = true;
      this.markPaused?.();
      await new Promise<void>((resolve) => {
        this.releasePause = resolve;
      });
    }
    await super.removePath(path);
  }
}

function place(system: RecordingSystem, path: string, bytes: Buffer): void {
  system.files.set(path, Buffer.from(bytes));
  system.present.add(path);
}

function gitBinding(expiresAt = "2026-08-26T23:00:00.000Z", generation = 7) {
  const fields = {
    forge: "github",
    owner: "papercupai",
    repository: "private-canary",
  };
  return {
    channel: "git" as const,
    credentialRef: {
      kind: "git" as const,
      ref: buildWorkspaceHostCredentialReference(
        "git-short-lived-delegation",
        fields,
      ),
    },
    delivery: {
      kind: "short-lived-delegation" as const,
      generation,
      audience: "workspace-host-canary",
      expiresAt,
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        "git-short-lived-delegation",
        fields,
        generation,
      ),
    },
    requestedAt: "2026-08-26T21:00:00.000Z",
  };
}

function agentBinding(generation = 7) {
  return {
    channel: "agent" as const,
    credentialRef: {
      kind: "agent" as const,
      ref: buildWorkspaceHostCredentialReference(
        "agent-encrypted-reference",
        AGENT_FIELDS,
      ),
    },
    delivery: {
      kind: "encrypted-reference" as const,
      generation,
      audience: "workspace-host-canary",
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        "agent-encrypted-reference",
        AGENT_FIELDS,
        generation,
      ),
    },
    requestedAt: "2026-08-26T21:00:00.000Z",
  };
}

function fixture() {
  const system = new RecordingSystem();
  const deps = createProductionWorkspaceHostRemoteInitializerDeps({
    system,
    workspaceRoot: "/workspaces",
    credentialMaterialRoot: MATERIAL_ROOT,
    now: () => NOW,
  });
  return { system, deps };
}

describe("ProductionWorkspaceHostRemoteInitializerHost optional desktop pack", () => {
  function attestation() {
    return {
      contractVersion: WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION,
      hostId: "host-1", action: "install", ubuntuVersion: "24.04",
      observedAt: NOW.toISOString(), status: "healthy",
      kasmvnc: { version: PINNED_KASMVNC_ARTIFACT.version, sha256: PINNED_KASMVNC_ARTIFACT.debSha256 },
      checks: WORKSPACE_HOST_DESKTOP_PACK_CHECKS.map((name) => ({ name, ok: true })),
    };
  }

  it("runs the maintained pinned installer and returns only its attestation", async () => {
    const { system, deps } = fixture();
    const proof = attestation();
    const run = vi.spyOn(system, "run").mockResolvedValue({
      exitCode: 0, stderr: "", stdout: `apt output\n${WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX}${JSON.stringify(proof)}\n`,
    });
    expect(await deps.host.installDesktopPack!({ hostId: "host-1" })).toEqual(proof);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].command).toBe("/bin/bash");
    const script = run.mock.calls[0][0].args[1];
    expect(script).toContain(PINNED_KASMVNC_ARTIFACT.debSha256);
    expect(script).toContain("DESKTOP_USER='papercusp-desktop'");
    expect(script).toContain("interface: 127.0.0.1");
  });

  it("does not turn an installer exit into successful evidence", async () => {
    const { system, deps } = fixture();
    vi.spyOn(system, "run").mockResolvedValue({ exitCode: 7, stdout: "", stderr: "package installation failed" });
    await expect(deps.host.installDesktopPack!({ hostId: "host-1" })).rejects.toThrow(/package installation failed/);
  });

  it("refuses exit zero without the required install attestation", async () => {
    const { deps } = fixture();
    await expect(deps.host.installDesktopPack!({ hostId: "host-1" })).rejects.toThrow(/no attestation/);
  });

  it.each(["host", "artifact", "checks"])("rejects incorrect %s evidence", async (change) => {
    const { system, deps } = fixture();
    const proof = attestation();
    if (change === "host") proof.hostId = "different-host";
    if (change === "artifact") proof.kasmvnc.sha256 = "0".repeat(64);
    if (change === "checks") proof.checks.pop();
    vi.spyOn(system, "run").mockResolvedValue({
      exitCode: 0, stderr: "", stdout: `${WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX}${JSON.stringify(proof)}`,
    });
    await expect(deps.host.installDesktopPack!({ hostId: "host-1" })).rejects.toThrow(/identity mismatch|missing checks/);
  });
});

describe("ProductionWorkspaceHostRemoteInitializerHost private Git credentials", () => {
  it.each(
    ["approve", "reject"]
      .flatMap((action) =>
        [false, true].flatMap((scoped) =>
          [false, true].map((newline) => ({
            action,
            scoped,
            newline,
            quoted: false,
          })),
        ),
      )
      .concat([
        { action: "approve", scoped: true, newline: false, quoted: true },
      ]),
  )(
    "keeps delivered bytes immutable after real Git $action (scoped=$scoped, newline=$newline, quoted=$quoted)",
    async ({ action, scoped, newline, quoted }) => {
      const directory = await mkdtemp(join(tmpdir(), "workspace-git-"));
      try {
        // Exercise shell quoting too: the helper's path is data, never shell code.
        const materialRoot = join(
          directory,
          quoted ? "credential's $(false) store" : "credentials",
        );
        const materialPath = workspaceHostCredentialMaterialPath(
          materialRoot,
          "git-short-lived-delegation",
          7,
        );
        const repositoryPath = "papercupai/private-canary.git";
        const bytes = Buffer.from(
          AUTHORIZATION_MATERIAL +
            (scoped ? `/${repositoryPath}` : "") +
            (newline ? "\n" : ""),
        );
        const request = parseWorkspaceHostCredentialDeliveryRequest({
          protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
          channel: "git",
          credentialRef: gitBinding().credentialRef.ref,
          generation: 7,
          material: bytes.toString("base64"),
        });
        const delivery = {
          filesystem: new NodeWorkspaceHostCredentialDeliveryFilesystem(),
          materialRoot,
          now: () => NOW,
        };
        await executeWorkspaceHostCredentialDelivery(request, delivery);

        // Only the clone transport is recorded. Delivery and Git's credential protocol use the
        // real filesystem and executable, without a network or any real authorization material.
        const system = new RecordingSystem();
        place(system, materialPath, bytes);
        const deps = createProductionWorkspaceHostRemoteInitializerDeps({
          system,
          workspaceRoot: "/workspaces",
          credentialMaterialRoot: materialRoot,
          now: () => NOW,
        });
        await deps.credentials.run("bind", gitBinding());
        await deps.host.cloneRepository({
          repositoryUrl: `https://github.com/${repositoryPath}`,
          visibility: "private",
          destination: "repository",
          credentialChannel: "git",
        });

        const ambientPath = join(directory, "ambient-material");
        const configPath = join(directory, "gitconfig");
        await writeFile(
          configPath,
          `[credential]\n\thelper = store --file=${ambientPath}\n`,
        );
        const env = {
          PATH: process.env.PATH,
          HOME: directory,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: configPath,
          ...system.commands[0]!.env,
        };
        expect(system.commands[0]!.env).toEqual(
          workspaceHostGetOnlyGitCredentialEnvironment(materialPath),
        );
        // useHttpPath requires a stored path to match a path-bearing request. A host-only
        // fixture exercises the host-only protocol; it must not authorize arbitrary paths.
        const query = `protocol=https\nhost=github.com\n${scoped ? `path=${repositoryPath}\n` : ""}\n`;
        const filled = spawnSync("git", ["credential", "fill"], {
          input: query,
          encoding: "utf8",
          env,
          cwd: directory,
          timeout: 5_000,
        });
        expect(filled.status, filled.stderr).toBe(0);
        expect(filled.stdout).toContain("username=git-user\n");
        expect(filled.stdout).toContain("password=private-token-value\n");
        const outsideScope = spawnSync("git", ["credential", "fill"], {
          input:
            "protocol=https\nhost=github.com\npath=other/repository.git\n\n",
          encoding: "utf8",
          env,
          cwd: directory,
          timeout: 5_000,
        });
        expect(outsideScope.status).toBe(128);
        expect(outsideScope.stdout).not.toContain("private-token-value");
        const result = spawnSync("git", ["credential", action], {
          input: filled.stdout + "\n",
          encoding: "utf8",
          env,
          cwd: directory,
          timeout: 5_000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(await readFile(materialPath)).toEqual(bytes);
        expect((await stat(materialPath)).mode & 0o777).toBe(0o600);
        await expect(stat(ambientPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          executeWorkspaceHostCredentialDelivery(request, delivery),
        ).resolves.toMatchObject({
          generation: 7,
          present: true,
        });
        await expect(
          executeWorkspaceHostCredentialDelivery(
            {
              ...request,
              material: new WorkspaceHostCredentialMaterial(
                Buffer.from("different material"),
              ),
            },
            delivery,
          ),
        ).rejects.toBeInstanceOf(
          WorkspaceHostCredentialGenerationConflictError,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("consumes only bound git-channel material outside argv and public evidence", async () => {
    const { system, deps } = fixture();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", gitBinding());

    // A fresh dependency graph models the next SSH step/new process. The bind must survive it.
    const fresh = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    const evidence = await fresh.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/private-canary.git",
      visibility: "private",
      destination: "repository",
      credentialChannel: "git",
    });

    expect(system.commands).toHaveLength(1);
    const command = system.commands[0]!;
    expect(command.args).toEqual([
      "clone",
      "--quiet",
      "https://github.com/papercupai/private-canary.git",
      "/workspaces/repository",
    ]);
    expect(command.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GCM_INTERACTIVE: "never",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: expect.stringContaining(
        `--file='${MATERIAL_PATH}' get`,
      ),
      GIT_CONFIG_KEY_2: "credential.useHttpPath",
      GIT_CONFIG_VALUE_2: "true",
    });
    expect(JSON.stringify(command.args)).not.toContain(AUTHORIZATION_MATERIAL);
    expect(JSON.stringify(evidence)).not.toContain(MATERIAL_PATH);
    expect(JSON.stringify(evidence)).not.toContain(AUTHORIZATION_MATERIAL);
    expect(evidence).toMatchObject({
      visibility: "private",
      credentialChannel: "git",
      cloned: true,
    });
  });

  it("reuses a clean existing checkout only when origin and revision match", async () => {
    const { system, deps } = fixture();
    const destination = "/workspaces/repository";
    system.present.add(destination);
    system.present.add(join(destination, ".git"));
    system.setResult(
      ["-C", destination, "rev-parse", "--is-inside-work-tree"],
      {
        exitCode: 0,
        stdout: "true\n",
        stderr: "",
      },
    );
    system.setResult(["-C", destination, "remote", "get-url", "origin"], {
      exitCode: 0,
      stdout: "https://github.com/papercupai/private-canary.git\n",
      stderr: "",
    });
    system.setResult(
      ["-C", destination, "status", "--porcelain=v1", "--untracked-files=all"],
      {
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    );
    system.setResult(
      ["-C", destination, "rev-parse", "--verify", "main^{commit}"],
      {
        exitCode: 0,
        stdout: "abc123\n",
        stderr: "",
      },
    );
    system.setResult(["-C", destination, "rev-parse", "HEAD"], {
      exitCode: 0,
      stdout: "abc123\n",
      stderr: "",
    });

    const evidence = await deps.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/private-canary.git",
      visibility: "public",
      destination: "repository",
      revision: "main",
    });

    expect(system.commands.some(({ args }) => args[0] === "clone")).toBe(false);
    expect(evidence).toMatchObject({
      destination,
      cloned: false,
      reused: true,
      revision: "main",
    });
  });

  it.each([
    {
      name: "different origin",
      expected:
        "existing destination /workspaces/repository has a different origin",
      origin: "https://github.com/other-owner/other-repository.git\n",
      status: "",
      requested: "abc123\n",
      head: "abc123\n",
    },
    {
      name: "dirty worktree",
      expected:
        "existing destination /workspaces/repository has uncommitted changes",
      origin: "https://github.com/papercupai/private-canary.git\n",
      status: " M README.md\n",
      requested: "abc123\n",
      head: "abc123\n",
    },
    {
      name: "incompatible revision",
      expected:
        "existing destination /workspaces/repository is not at requested revision main",
      origin: "https://github.com/papercupai/private-canary.git\n",
      status: "",
      requested: "abc123\n",
      head: "def456\n",
    },
  ])(
    "refuses an unsafe existing checkout ($name)",
    async ({ expected, origin, status, requested, head }) => {
      const { system, deps } = fixture();
      const destination = "/workspaces/repository";
      system.present.add(destination);
      system.present.add(join(destination, ".git"));
      system.setResult(
        ["-C", destination, "rev-parse", "--is-inside-work-tree"],
        {
          exitCode: 0,
          stdout: "true\n",
          stderr: "",
        },
      );
      system.setResult(["-C", destination, "remote", "get-url", "origin"], {
        exitCode: 0,
        stdout: origin,
        stderr: "",
      });
      system.setResult(
        [
          "-C",
          destination,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ],
        {
          exitCode: 0,
          stdout: status,
          stderr: "",
        },
      );
      system.setResult(
        ["-C", destination, "rev-parse", "--verify", "main^{commit}"],
        {
          exitCode: 0,
          stdout: requested,
          stderr: "",
        },
      );
      system.setResult(["-C", destination, "rev-parse", "HEAD"], {
        exitCode: 0,
        stdout: head,
        stderr: "",
      });

      await expect(
        deps.host.cloneRepository({
          repositoryUrl: "https://github.com/papercupai/private-canary.git",
          visibility: "public",
          destination: "repository",
          revision: "main",
        }),
      ).rejects.toThrow(expected);
      expect(system.commands.some(({ args }) => args[0] === "clone")).toBe(
        false,
      );
    },
  );

  it("fails closed before spawning git when bound material is absent", async () => {
    const { system, deps } = fixture();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", gitBinding());
    system.present.delete(MATERIAL_PATH);

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: "https://github.com/papercupai/private-canary.git",
        visibility: "private",
        destination: "repository",
        credentialChannel: "git",
      }),
    ).rejects.toThrow("bound git credential material is absent");
    expect(system.commands).toEqual([]);
  });

  it("refuses a private clone routed through any channel other than git", async () => {
    const { system, deps } = fixture();

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: "https://github.com/papercupai/private-canary.git",
        visibility: "private",
        destination: "repository",
        credentialChannel: "cloud",
      }),
    ).rejects.toThrow("must consume the bound 'git' credential channel");
    expect(system.commands).toEqual([]);
  });

  it("fails closed before spawning git when bound material is expired", async () => {
    const { system, deps } = fixture();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", gitBinding("2026-08-26T21:59:59.000Z"));

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: "https://github.com/papercupai/private-canary.git",
        visibility: "private",
        destination: "repository",
        credentialChannel: "git",
      }),
    ).rejects.toThrow("bound git credential material has expired");
    expect(system.commands).toEqual([]);
  });

  it("fails closed before spawning git after the active binding is revoked", async () => {
    const { system, deps } = fixture();
    const binding = gitBinding();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", binding);
    await deps.credentials.run("revoke", binding);

    await expect(
      deps.host.cloneRepository({
        repositoryUrl: "https://github.com/papercupai/private-canary.git",
        visibility: "private",
        destination: "repository",
        credentialChannel: "git",
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostOperationError);
    expect(system.commands).toEqual([]);
  });

  it("keeps a newer Git generation active when an old process revokes its generation", async () => {
    const { system, deps } = fixture();
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await deps.credentials.run("bind", gitBinding());

    const generation8Path = workspaceHostCredentialMaterialPath(
      MATERIAL_ROOT,
      "git-short-lived-delegation",
      8,
    );
    place(
      system,
      generation8Path,
      Buffer.from("https://git-user:rotated@github.com"),
    );
    const rotated = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    await rotated.credentials.run(
      "bind",
      gitBinding("2026-08-26T23:00:00.000Z", 8),
    );

    // Model a delayed generation-7 process after generation 8 is already active.
    const stale = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    await stale.credentials.run("revoke", gitBinding());
    await stale.credentials.run("verify-revoked", gitBinding());

    await rotated.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/private-canary.git",
      visibility: "private",
      destination: "repository",
      credentialChannel: "git",
    });
    expect(system.commands.at(-1)?.env?.GIT_CONFIG_VALUE_1).toContain(
      `--file='${generation8Path}' get`,
    );
  });

  it("serializes a racing stale Git revoke before a newer cross-process bind", async () => {
    const system = new PausingRecordingSystem();
    const first = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    place(system, MATERIAL_PATH, Buffer.from(AUTHORIZATION_MATERIAL));
    await first.credentials.run("bind", gitBinding());
    system.pauseRemovalAt(
      WorkspaceHostGitCredentialBindingRegistry.statePath(MATERIAL_ROOT),
    );

    const staleRevoke = first.credentials.run("revoke", gitBinding());
    await system.paused;
    const generation8Path = workspaceHostCredentialMaterialPath(
      MATERIAL_ROOT,
      "git-short-lived-delegation",
      8,
    );
    place(
      system,
      generation8Path,
      Buffer.from("https://git-user:rotated@github.com"),
    );
    const newer = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    let newerFinished = false;
    const newerBind = newer.credentials
      .run("bind", gitBinding("2026-08-26T23:00:00.000Z", 8))
      .then(() => {
        newerFinished = true;
      });
    await Promise.resolve();
    expect(newerFinished).toBe(false);

    system.release();
    await Promise.all([staleRevoke, newerBind]);
    await newer.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/private-canary.git",
      visibility: "private",
      destination: "repository",
      credentialChannel: "git",
    });
    expect(system.commands.at(-1)?.env?.GIT_CONFIG_VALUE_1).toContain(
      `--file='${generation8Path}' get`,
    );
  });

  it("keeps the canonical workspace root aligned with the bootstrap data root", () => {
    expect(WORKSPACE_HOST_DEFAULT_WORKSPACE_ROOT).toBe(
      WORKSPACE_HOST_DATA_ROOT,
    );
  });
});

describe("ProductionWorkspaceHostRemoteInitializerHost agent credential consumer", () => {
  it("materializes delivered bytes into native homes and verifies them in a fresh process", async () => {
    const { system, deps } = fixture();
    const bundle = encodeWorkspaceHostAgentHomeBundle({
      claude: Buffer.from(
        '{"account":"claude-canary","claudeAiOauth":{"accessToken":"claude-canary-access","refreshToken":"canonical-writer-only"}}',
      ),
      codex: Buffer.from(
        '{"account":"codex-canary","auth_mode":"chatgpt","tokens":{"access_token":"codex-canary-access","refresh_token":"canonical-writer-only","id_token":"codex-canary-id"}}',
      ),
      omp: Buffer.from('{"account":"omp-canary"}'),
    });
    const materialPath = workspaceHostCredentialMaterialPath(
      MATERIAL_ROOT,
      "agent-encrypted-reference",
      7,
    );
    place(system, materialPath, bundle);

    await deps.credentials.run("bind", agentBinding());
    const fresh = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    await expect(
      fresh.credentials.run("verify-bound", agentBinding()),
    ).resolves.toMatchObject({
      family: "agent-encrypted-reference",
      generation: 7,
    });

    // The CUSTOMER workspace account's home (D-421): that account runs every customer-driven
    // agent, so its own credential lives there. Between D-248 and D-421 this was the platform
    // agent home, which no customer-driven agent reads; nothing may be left there.
    const paths = workspaceHostAgentHomePaths("/home/papercusp-workspace");
    for (const legacy of Object.values(
      workspaceHostAgentHomePaths("/home/papercusp-agent"),
    ))
      expect(system.files.has(legacy)).toBe(false);
    expect(system.files.get(paths.claude)).toEqual(
      Buffer.from(
        // Claude's refresh credential is NEUTRALIZED (empty) exactly like Codex's below, and
        // the access token is RETAINED so the guest CLI can still perform real inference
        // (WI-10001691). Asserting the materialized bytes is what makes this a test of the
        // projection rather than a fixture that merely satisfies its input validation.
        '{"account":"claude-canary","claudeAiOauth":{"accessToken":"claude-canary-access","refreshToken":""}}',
      ),
    );
    expect(system.files.get(paths.codex)).toEqual(
      Buffer.from(
        // The refresh credential is NEUTRALIZED (empty), never removed: the Codex CLI requires
        // the field to deserialize auth.json at all (P-305 G6 root cause, measured 2026-09-11).
        '{"account":"codex-canary","auth_mode":"chatgpt","tokens":{"access_token":"codex-canary-access","refresh_token":"","id_token":"codex-canary-id"}}',
      ),
    );
    expect(system.files.get(paths.omp)).toEqual(
      Buffer.from('{"account":"omp-canary"}'),
    );

    await fresh.credentials.run("revoke", agentBinding());
    for (const path of Object.values(paths))
      expect(system.files.has(path)).toBe(false);
    await expect(
      fresh.credentials.run("verify-revoked", agentBinding()),
    ).resolves.toMatchObject({
      operation: "verify-revoked",
    });
  });
});

describe("ProductionWorkspaceHostRemoteInitializerHost agent probe environment", () => {
  it("does not invoke an excluded runtime through the production host adapter", async () => {
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system: new RecordingSystem(), workspaceRoot: "/workspaces", credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: { async run(invocation) {
        invocations.push(invocation);
        return { exitCode: 1, stdout: "" };
      } }, now: () => NOW,
    }).host;
    const report = await host.probeAgentVerification(["claude", "omp"]);
    expect(invocations.some((entry) => entry.command === "codex")).toBe(false);
    expect(invocations.map((entry) => entry.command)).toEqual(["claude", "omp", "omp"]);
    expect(report.requestedAgents).toEqual(["claude", "omp"]);
    expect(report.agents.codex).toBeUndefined();
    expect(report.allReady).toBe(false);
  });

  it("runs the probes as the CUSTOMER workspace account with only explicit variables, never the platform agent identity and never ambient controller credentials (D-421)", async () => {
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return invocation.command === "omp"
          ? { exitCode: 0, stdout: '{"account":"can…001"}' }
          : { exitCode: 0, stdout: "logged in as canary@example.test" };
      },
    };
    const system = new RecordingSystem();
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: runner,
      now: () => NOW,
    }).host;
    await host.probeAgentVerification();
    for (const invocation of invocations) {
      // The probe runs as the identity every customer-driven agent runs as (D-421), so a pass
      // proves the product path. D-043 still holds because its PATH reaches only the customer
      // toolchain, never the release bin. The negative is asserted alongside the positive: the
      // platform agent identity is what this was between D-248 and D-421, and an accidental
      // revert would otherwise read as a passing test.
      expect(invocation.env).toEqual({
        HOME: "/home/papercusp-workspace",
        USER: "papercusp-workspace",
        LOGNAME: "papercusp-workspace",
        PATH: `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      });
      expect(invocation.env?.PATH).not.toContain("/opt/papercusp");
      expect(invocation.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(invocation.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(invocation.runAsUser).toBe("papercusp-workspace");
      expect(invocation.runAsUser).not.toBe("papercusp-agent");
    }
  });

  it("execs the vendor path the attestation recorded, not the bare name that resolves to a launcher wrapper (D-259 Defect 2)", async () => {
    const vendor = {
      claude: "/home/papercusp-agent/.local/bin/claude",
      codex: "/home/papercusp-agent/.papercusp/runtime/node_modules/.bin/codex",
      omp: "/home/papercusp-agent/.local/bin/omp",
    };
    // D-423: the attested installs live in the platform agent home, which the probing customer
    // account cannot read, so each attested CLI is executed from its customer-toolchain copy.
    const toolchain = {
      claude: `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/claude`,
      codex: `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/codex`,
      omp: `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/omp`,
    };
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return invocation.command === toolchain.omp
          ? { exitCode: 0, stdout: '{"account":"can…001"}' }
          : { exitCode: 0, stdout: "logged in as canary@example.test" };
      },
    };
    const system = new RecordingSystem();
    await system.writePrivateFile(
      WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE,
      Buffer.from(
        JSON.stringify({
          runtime: {
            agentRuntimesInstalledByBootstrap: true,
            agentRuntimes: vendor,
          },
        }),
      ),
    );
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: runner,
      now: () => NOW,
    }).host;

    await host.probeAgentVerification();

    // `codex` twice is correct, not a duplicate (WI-10001694): its `authenticated-account` probe
    // is `satisfiesReadiness: false`, so unlike `omp` — whose first spec IS readiness-bearing and
    // breaks the loop on this all-exit-0 runner — it can never end the loop, and codex's
    // live-inference probe always runs after it. Both specs exec the SAME attested vendor path,
    // which is the property this case exists to pin: the runtime path replaces the command for
    // EVERY spec of an agent, so a regression that reverted only the second one would show up
    // here as a bare name in this list.
    expect(invocations.map((invocation) => invocation.command)).toEqual([
      toolchain.claude,
      toolchain.codex,
      toolchain.codex,
      toolchain.omp,
    ]);
    // Neither the attested agent-home path nor a release-bin wrapper is ever executed: the first
    // is unreadable to the customer account, the second is Papercusp code D-043 keeps from it.
    for (const invocation of invocations) {
      expect(Object.values(vendor)).not.toContain(invocation.command);
      expect(invocation.env?.PATH).toBe(
        `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      );
      expect(
        invocation.command.startsWith(WORKSPACE_HOST_RELEASE_BIN_DIR),
      ).toBe(false);
    }
  });

  it("falls back to the bare command when no attestation exists, so a pre-install host fails its probe rather than erroring", async () => {
    const invocations: WorkspaceHostAgentProbeInvocation[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return { exitCode: 127, stdout: "" };
      },
    };
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system: new RecordingSystem(),
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: runner,
      now: () => NOW,
    }).host;

    const report = await host.probeAgentVerification();

    // `codex` and `omp` twice each are correct, not duplicates: for both agents the
    // account probe failed, so the second spec ran as the documented fallback — codex's
    // live-inference probe (D-265) and omp's local-inference probe — and both fell back to the
    // bare name because this host has no attestation.
    expect(invocations.map((invocation) => invocation.command)).toEqual([
      "claude",
      "codex",
      "codex",
      "omp",
      "omp",
    ]);
    expect(report.allReady).toBe(false);
  });

  it("refuses an attested path inside the release bin — that directory holds wrappers, not vendor CLIs", async () => {
    const system = new RecordingSystem();
    await system.writePrivateFile(
      WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE,
      Buffer.from(
        JSON.stringify({
          runtime: {
            agentRuntimes: {
              claude: `${WORKSPACE_HOST_RELEASE_BIN_DIR}/claude`,
            },
          },
        }),
      ),
    );
    const host = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      agentProbeRunner: {
        async run() {
          throw new Error("probe must not run against a wrapper path");
        },
      },
      now: () => NOW,
    }).host;

    await expect(host.probeAgentVerification()).rejects.toThrow(
      /holds launcher wrappers rather than vendor CLIs/,
    );
  });

  it("refuses a corrupt attestation instead of silently degrading to the bare-name fallback", async () => {
    // The distinction the fallback above depends on: ABSENT means "this host has no vendor
    // runtime" and is a legitimate probe failure; MALFORMED means the attestation says something
    // unreadable, and treating that as absent would report a probe failure whose real cause was a
    // corrupt attestation nobody ever looked at.
    for (const body of [
      "{not json",
      JSON.stringify({ runtime: { agentRuntimes: ["/usr/bin/claude"] } }),
      JSON.stringify({ runtime: { agentRuntimes: { claude: "claude" } } }),
    ]) {
      const system = new RecordingSystem();
      await system.writePrivateFile(
        WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_FILE,
        Buffer.from(body),
      );
      const host = createProductionWorkspaceHostRemoteInitializerDeps({
        system,
        workspaceRoot: "/workspaces",
        credentialMaterialRoot: MATERIAL_ROOT,
        agentProbeRunner: {
          async run() {
            throw new Error("probe must not run against a corrupt attestation");
          },
        },
        now: () => NOW,
      }).host;
      await expect(host.probeAgentVerification()).rejects.toThrow();
    }
  });

  it("refuses to run the agents as the workspace SSH account (D-043, D-248)", () => {
    // The collapse is the whole defect, and nothing downstream catches it: delivered credentials
    // land in the customer's own home and the customer's login must read the runtime, while
    // every individual check still passes.
    expect(() =>
      createProductionWorkspaceHostRemoteInitializerDeps({
        system: new RecordingSystem(),
        workspaceRoot: "/workspaces",
        credentialMaterialRoot: MATERIAL_ROOT,
        agentUser: "papercusp-workspace",
        now: () => NOW,
      }),
    ).toThrow(/agentUser must differ from workspaceUser/);
  });
});

describe("ProductionWorkspaceHostRemoteInitializerHost cloned-repository observation", () => {
  // The packaged initializer builds a fresh dependency graph for every SSH invocation, so the
  // clone step and the verify-initialization step never share a JS object. These tests instantiate
  // separate production adapters over ONE filesystem for exactly that reason: a clone descriptor
  // remembered on the cloning instance would satisfy neither of them.
  it("reports a clone performed by a separate adapter over the same filesystem", async () => {
    const system = new RecordingSystem();
    const cloning = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    // `run` is a double, so the clone's filesystem effect is modelled rather than executed.
    await cloning.host.cloneRepository({
      repositoryUrl: "https://github.com/papercupai/public-canary.git",
      visibility: "public",
      destination: "repository",
    });

    const verifying = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });
    // The adapters must be genuinely distinct, or this asserts nothing about a fresh process.
    expect(verifying.host).not.toBe(cloning.host);

    await expect(
      verifying.host.describeClonedRepository({
        destination: "repository",
        visibility: "public",
      }),
    ).resolves.toEqual({ visibility: "public", cloned: true });
  });

  // Non-vacuity control: without this, an implementation returning a constant `cloned: true` would
  // pass the test above. The observation has to be able to say NO.
  it("reports cloned:false when no .git directory is present", async () => {
    const system = new RecordingSystem();
    const { host } = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });

    await expect(
      host.describeClonedRepository({
        destination: "repository",
        visibility: "public",
      }),
    ).resolves.toEqual({ visibility: "public", cloned: false });
  });
});

/**
 * WI-10004594. The customer's workspace directory sits under the bootstrap's ACL'd root
 * (`/srv/papercusp/workspaces`, default ACL naming the service, SSH and agent accounts). On a
 * file with an ACL the mode's GROUP bits ARE the ACL mask, so creating it through the PRIVATE
 * 0700 credential form set `mask::---` and the operator service account could no longer traverse
 * it — the portal's "add a pot" answered "path does not exist" on a live hosted host.
 */
describe("ProductionWorkspaceHostRemoteInitializerHost workspace directory (WI-10004594)", () => {
  class OwnershipRecordingSystem extends RecordingSystem {
    readonly ownership = new Map<string, string>();
    async setOwnership(path: string, owner: string, group: string) {
      this.ownership.set(path, `${owner}:${group}`);
    }
  }

  it("creates the workspace directory with the shared workspace form, not the private 0700 form", async () => {
    const system = new OwnershipRecordingSystem();
    const { host } = createProductionWorkspaceHostRemoteInitializerDeps({
      system,
      workspaceRoot: "/workspaces",
      credentialMaterialRoot: MATERIAL_ROOT,
      now: () => NOW,
    });

    const evidence = await host.createWorkspace({
      workspaceId: "papercusp-workspace",
      hostId: "host-1",
    });

    expect(evidence).toMatchObject({ directory: "/workspaces/papercusp-workspace", created: true });
    expect(system.directoryForms.get("/workspaces/papercusp-workspace")).toBe("workspace");
    expect(system.ownership.get("/workspaces/papercusp-workspace")).toBe(
      "papercusp-workspace:papercusp-workspace",
    );
  });

  async function scratch(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "wi-10004594-"));
  }
  const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

  it("NodeWorkspaceHostSystem creates the directory 0770 and repairs an existing 0700 one", async () => {
    const root = await scratch();
    try {
      const system = new NodeWorkspaceHostSystem();
      const fresh = join(root, "fresh");
      await system.ensureWorkspaceDirectory(fresh);
      expect(await modeOf(fresh)).toBe(0o770);

      const existing = join(root, "existing");
      await mkdir(existing);
      await chmod(existing, 0o700);
      await system.ensureWorkspaceDirectory(existing);
      expect(await modeOf(existing)).toBe(0o770);

      // The private form is unchanged: credential and home directories stay 0700.
      const credential = join(root, "credential");
      await system.ensureDirectory(credential);
      expect(await modeOf(credential)).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("NodeWorkspaceHostSystem refuses a symlink where the workspace directory belongs", async () => {
    const root = await scratch();
    try {
      const target = join(root, "elsewhere");
      await mkdir(target);
      const link = join(root, "workspace");
      await symlink(target, link);
      await expect(new NodeWorkspaceHostSystem().ensureWorkspaceDirectory(link)).rejects.toThrow(
        /refusing non-directory or symlink at workspace directory/,
      );
      expect(await modeOf(target)).not.toBe(0o770);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("NodeWorkspaceHostSystem does not change a symlink target's ownership", async (context) => {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const primaryGid = typeof process.getgid === "function" ? process.getgid() : undefined;
    if (uid === undefined || primaryGid === undefined) return context.skip();

    const supplementaryGid =
      typeof process.getgroups === "function"
        ? process.getgroups().find((gid) => gid !== primaryGid)
        : undefined;
    const targetGid = supplementaryGid ?? (uid === 0 ? (primaryGid === 0 ? 1 : 0) : undefined);
    if (targetGid === undefined) return context.skip();

    const root = await scratch();
    try {
      const target = join(root, "protected-target");
      const link = join(root, "workspace-link");
      await writeFile(target, "protected");
      await symlink(target, link);
      const before = await stat(target);

      await new NodeWorkspaceHostSystem().setOwnership(link, String(uid), String(targetGid));

      const after = await stat(target);
      expect({ uid: after.uid, gid: after.gid }).toEqual({ uid: before.uid, gid: before.gid });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const hasAclTools =
    spawnSync("setfacl", ["--version"]).status === 0 &&
    spawnSync("getfacl", ["--version"]).status === 0;

  // The production failure itself, on a real filesystem with a real default ACL shaped like the
  // bootstrap's. The private-form control proves this test can see a voided mask at all.
  it.skipIf(!hasAclTools)(
    "under a default ACL the workspace form keeps mask::rwx while the private form voids it",
    async (context) => {
      const root = await scratch();
      try {
        const me = userInfo().username;
        const acl = `u:${me}:rwx,m::rwx,o::---`;
        const set = spawnSync("setfacl", ["-m", acl, "-d", "-m", acl, root], { encoding: "utf8" });
        if (set.status !== 0 && /Operation not supported/.test(set.stderr)) {
          // A filesystem without ACL support cannot express the failure: report a SKIP, not a pass.
          context.skip();
        }
        expect(set.status, set.stderr).toBe(0);
        const maskOf = (path: string) => {
          const out = spawnSync("getfacl", ["--omit-header", "--absolute-names", path], {
            encoding: "utf8",
          });
          expect(out.status).toBe(0);
          return /^mask::(\S+)$/m.exec(out.stdout)?.[1];
        };
        const system = new NodeWorkspaceHostSystem();

        const workspace = join(root, "papercusp-workspace");
        await system.ensureWorkspaceDirectory(workspace);
        expect(maskOf(workspace)).toBe("rwx");

        const privateForm = join(root, "private-form");
        await system.ensureDirectory(privateForm);
        expect(maskOf(privateForm)).toBe("---");

        // Re-running the workspace form over a directory the old code left voided repairs it.
        await system.ensureWorkspaceDirectory(privateForm);
        expect(maskOf(privateForm)).toBe("rwx");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

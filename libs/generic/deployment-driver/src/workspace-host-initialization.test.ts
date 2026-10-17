import { describe, expect, it } from "vitest";
import {
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  ReplaySafeWorkspaceHostInitializationExecutor,
  WorkspaceHostCredentialDeliveryCapabilityError,
  buildWorkspaceHostBackupCredentialManifest,
  buildWorkspaceHostBackupRestoreCredentialRebindRequest,
  executeWorkspaceHostInitialization,
  planWorkspaceHostCredentialLifecycle,
  planWorkspaceHostInitialization,
  validateWorkspaceHostInitializationCanary,
  workspaceHostInitializationStepFingerprint,
  type WorkspaceHostCredentialDeliverySet,
  type WorkspaceHostInitializationCanaryEvidence,
  type WorkspaceHostInitializationReplayIdentity,
  type WorkspaceHostInitializationReplayStore,
  type WorkspaceHostInitializationRequest,
  type WorkspaceHostInitializationStepReceipt,
} from "./workspace-host-initialization";
import type { WorkspaceHostCredentialRefs } from "./workspace-host-types";

const REQUESTED_AT = "2026-08-22T10:00:00Z";

function refs(suffix = "v1"): WorkspaceHostCredentialRefs {
  return {
    cloudCredentialRef: { kind: "cloud", ref: `cloud-resolver:${suffix}` },
    gitCredentialRef: { kind: "git", ref: `git-resolver:${suffix}` },
    agentCredentialRef: { kind: "agent", ref: `agent-resolver:${suffix}` },
  };
}

function delivery(generation = 1): WorkspaceHostCredentialDeliverySet {
  return {
    cloud: {
      kind: "provider-identity",
      generation,
      audience: "host-1",
      revocationRef: `revoke-cloud-${generation}`,
    },
    git: {
      kind: "forwarded-agent",
      generation,
      audience: "host-1",
      revocationRef: `revoke-git-${generation}`,
    },
    agent: {
      kind: "short-lived-delegation",
      generation,
      audience: "host-1",
      revocationRef: `revoke-agent-${generation}`,
      expiresAt: "2026-08-22T11:00:00Z",
    },
  };
}

/** A provider that can transfer files, i.e. one that may carry the git and agent channels. */
const CAPABLE = { fileTransfer: true } as const;
/** A provider that cannot; every delivery-bearing channel must be refused at plan time (D-215). */
const NO_FILE_TRANSFER = { fileTransfer: false } as const;

function request(
  overrides: Partial<WorkspaceHostInitializationRequest> = {},
): WorkspaceHostInitializationRequest {
  return {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId: "init-1",
    workspaceId: "workspace-1",
    hostId: "host-1",
    requestedAt: REQUESTED_AT,
    source: { kind: "empty" },
    credentialRefs: refs(),
    credentialDelivery: delivery(),
    deliveryCapabilities: CAPABLE,
    ...overrides,
  };
}

describe("planWorkspaceHostInitialization", () => {
  it("verifies retained data before bindings without creating or importing a workspace", () => {
    const plan = planWorkspaceHostInitialization(request({ source: { kind: "retained", tenantIdentity: "a".repeat(64) } }));
    expect(plan.steps[0]).toMatchObject({ kind: "verify-retained-workspace", input: { tenantIdentity: "a".repeat(64), workspaceId: "workspace-1" } });
    expect(plan.steps.some((step) => ["create-workspace", "import-workspace", "clone-repository"].includes(step.kind))).toBe(false);
    expect(plan.steps.at(-1)?.input.sourceKind).toBe("retained");
    expect(() => planWorkspaceHostInitialization(request({ source: { kind: "retained", tenantIdentity: "" } }))).toThrow(/tenantIdentity/);
  });
  it("persists requested-agent coverage in the replay fingerprint and rejects empty coverage", () => {
    const scoped = planWorkspaceHostInitialization(request({ requestedAgents: ["omp", "claude"] }));
    const verify = scoped.steps.at(-1)!;
    const full = planWorkspaceHostInitialization(request()).steps.at(-1)!;
    expect(verify.input.requestedAgents).toEqual(["claude", "omp"]);
    expect(workspaceHostInitializationStepFingerprint(verify)).not.toBe(workspaceHostInitializationStepFingerprint(full));
    expect(() => planWorkspaceHostInitialization(request({ requestedAgents: [] }))).toThrow(/requestedAgents/);
  });

  it("creates an empty workspace and binds three distinct runtime channels after bootstrap", () => {
    const first = planWorkspaceHostInitialization(request());
    const replay = planWorkspaceHostInitialization(request());
    expect(first).toEqual(replay);
    expect(first.steps.map((step) => step.id)).toEqual([
      "workspace",
      "bind-cloud",
      "bind-git",
      "bind-agent",
      "verify",
    ]);
    expect(first.steps.at(-1)?.dependsOn).toEqual([
      "bind-cloud",
      "bind-git",
      "bind-agent",
    ]);
    expect(JSON.stringify(first)).not.toMatch(
      /PRIVATE KEY|resolvedAuthorization/i,
    );
  });

  it("models private clone through the Git channel without embedding authorization in the URL", () => {
    const plan = planWorkspaceHostInitialization(
      request({
        source: {
          kind: "git",
          repositoryUrl: "https://github.com/papercusp/private-repo.git",
          visibility: "private",
          destination: "repositories/private-repo",
          revision: "main",
        },
      }),
    );
    expect(plan.steps[1]).toMatchObject({
      id: "bind-git",
      kind: "bind-credential",
      dependsOn: ["workspace"],
    });
    expect(plan.steps[2]).toMatchObject({
      id: "source",
      kind: "clone-repository",
      dependsOn: ["bind-git"],
      input: { credentialChannel: "git" },
    });
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "git",
            repositoryUrl:
              "https://name:authorization@github.com/acme/repo.git",
            visibility: "private",
            destination: "repositories/repo",
          },
        }),
      ),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "git",
            repositoryUrl: "https://authorization@github.com/acme/repo.git",
            visibility: "private",
            destination: "repositories/repo",
          },
        }),
      ),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "git",
            repositoryUrl: "https://github.com/acme/repo.git",
            visibility: "private",
            destination: "repositories/repo",
          },
          credentialRefs: { cloudCredentialRef: refs().cloudCredentialRef },
          credentialDelivery: { cloud: delivery().cloud },
        }),
      ),
    ).toThrow(/requires gitCredentialRef/);
  });

  it("requires an explicit allowlist for pairing/import and rejects unrelated-state defaults", () => {
    expect(
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "pair",
            sourceWorkspaceId: "workspace-source",
            pairingReference: { kind: "pairing", ref: "pairing:request-1" },
            include: ["repositories", "transcripts"],
          },
        }),
      ).steps[1],
    ).toMatchObject({ kind: "pair-workspace" });
    expect(
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "import",
            sourceWorkspaceId: "workspace-source",
            sourceSnapshotRef: "snapshot:backup-1",
            include: ["files", "database"],
          },
        }),
      ).steps[1],
    ).toMatchObject({ kind: "import-workspace" });
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          source: {
            kind: "import",
            sourceWorkspaceId: "workspace-source",
            sourceSnapshotRef: "snapshot:backup-1",
            include: [],
          },
        }),
      ),
    ).toThrow(/explicitly select at least one unit/);
  });

  it("rejects shared resolver ids and channel-inappropriate delivery", () => {
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          credentialRefs: {
            cloudCredentialRef: { kind: "cloud", ref: "resolver:same" },
            gitCredentialRef: { kind: "git", ref: "resolver:same" },
          },
          credentialDelivery: {
            cloud: delivery().cloud,
            git: delivery().git,
          },
        }),
      ),
    ).toThrow(/must be distinct/);
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          credentialDelivery: {
            ...delivery(),
            cloud: { ...delivery().cloud, kind: "forwarded-agent" },
          },
        }),
      ),
    ).toThrow(/not allowed for that channel/);
  });
});

describe("executeWorkspaceHostInitialization", () => {
  it("executes the dependency order and accepts structured redacted receipts", async () => {
    const plan = planWorkspaceHostInitialization(request());
    const seen: string[] = [];
    const receipts = await executeWorkspaceHostInitialization(plan, {
      execute: async (step) => {
        seen.push(step.id);
        return {
          stepId: step.id,
          status: "succeeded",
          observedAt: "2026-08-22T10:05:00Z",
          publicEvidence: { check: step.kind, ok: true },
        };
      },
    });
    expect(seen).toEqual(plan.steps.map((step) => step.id));
    expect(receipts).toHaveLength(plan.steps.length);
  });

  it("fails closed when an adapter tries to persist authorization-shaped evidence", async () => {
    const plan = planWorkspaceHostInitialization(request());
    await expect(
      executeWorkspaceHostInitialization(plan, {
        execute: async (step) => ({
          stepId: step.id,
          status: "succeeded",
          observedAt: "2026-08-22T10:05:00Z",
          publicEvidence: { apiToken: "must-never-persist" },
        }),
      }),
    ).rejects.toThrow(/Secret-shaped field/);
  });
});

describe("ReplaySafeWorkspaceHostInitializationExecutor", () => {
  function memoryReplayStore(): WorkspaceHostInitializationReplayStore {
    const records = new Map<
      string,
      {
        fingerprint: string;
        receipt: WorkspaceHostInitializationStepReceipt;
      }
    >();
    return {
      async runOnce(
        identity: WorkspaceHostInitializationReplayIdentity,
        run: () => Promise<WorkspaceHostInitializationStepReceipt>,
      ) {
        const prior = records.get(identity.idempotencyKey);
        if (prior) {
          if (prior.fingerprint !== identity.stepFingerprint) {
            throw new Error(
              "idempotency key reused for different initialization input",
            );
          }
          return prior.receipt;
        }
        const receipt = await run();
        records.set(identity.idempotencyKey, {
          fingerprint: identity.stepFingerprint,
          receipt,
        });
        return receipt;
      },
    };
  }

  it("executes one declared host operation and replays its persisted receipt", async () => {
    const step = planWorkspaceHostInitialization(request()).steps[0]!;
    const seen: string[] = [];
    const executor = new ReplaySafeWorkspaceHostInitializationExecutor({
      operations: {
        supportedStepKinds: ["create-workspace"],
        async execute(current) {
          seen.push(current.idempotencyKey);
          return {
            observedAt: "2026-08-22T10:05:00Z",
            publicEvidence: { workspaceCreated: true },
          };
        },
      },
      replayStore: memoryReplayStore(),
    });

    const first = await executor.execute(step);
    const replay = await executor.execute(step);

    expect(first).toEqual(replay);
    expect(seen).toEqual([step.idempotencyKey]);
  });

  it("accepts the remote adapter's known lifecycle capability superset", async () => {
    const step = planWorkspaceHostInitialization(request()).steps[0]!;
    const seen: string[] = [];
    const executor = new ReplaySafeWorkspaceHostInitializationExecutor({
      operations: {
        // The concrete GCP adapter serves both runners and therefore advertises all ten wire
        // kinds. Initialization execution must accept that manifest while still receiving only
        // the six initialization step shapes here.
        supportedStepKinds: [
          ...WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
          ...WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS,
        ],
        async execute(current) {
          seen.push(current.id);
          return { observedAt: "2026-08-22T10:05:00Z" };
        },
      },
      replayStore: memoryReplayStore(),
    });

    await expect(executor.execute(step)).resolves.toMatchObject({
      stepId: step.id,
      status: "succeeded",
    });
    expect(seen).toEqual([step.id]);
  });

  it("fails closed before execution when a host adapter does not declare the step kind", async () => {
    const clone = planWorkspaceHostInitialization(
      request({
        source: {
          kind: "git",
          repositoryUrl: "https://github.com/papercusp/public.git",
          visibility: "public",
          destination: "repositories/public",
        },
      }),
    ).steps.find((step) => step.kind === "clone-repository")!;
    let called = false;
    const executor = new ReplaySafeWorkspaceHostInitializationExecutor({
      operations: {
        supportedStepKinds: ["create-workspace"],
        async execute() {
          called = true;
          return { observedAt: "2026-08-22T10:05:00Z" };
        },
      },
      replayStore: memoryReplayStore(),
    });

    await expect(executor.execute(clone)).rejects.toThrow(/not supported/);
    expect(called).toBe(false);
  });

  it("rejects secret-shaped evidence from both fresh operations and replay storage", async () => {
    const step = planWorkspaceHostInitialization(request()).steps[0]!;
    const fresh = new ReplaySafeWorkspaceHostInitializationExecutor({
      operations: {
        supportedStepKinds: ["create-workspace"],
        async execute() {
          return {
            observedAt: "2026-08-22T10:05:00Z",
            publicEvidence: { accessToken: "must-never-persist" },
          };
        },
      },
      replayStore: memoryReplayStore(),
    });
    await expect(fresh.execute(step)).rejects.toThrow(/Secret-shaped field/);

    const replayed = new ReplaySafeWorkspaceHostInitializationExecutor({
      operations: {
        supportedStepKinds: ["create-workspace"],
        async execute() {
          throw new Error("replay store should not execute the operation");
        },
      },
      replayStore: {
        async runOnce() {
          return {
            stepId: step.id,
            status: "succeeded",
            observedAt: "2026-08-22T10:05:00Z",
            publicEvidence: { privateKey: "must-never-replay" },
          };
        },
      },
    });
    await expect(replayed.execute(step)).rejects.toThrow(/Secret-shaped field/);
  });

  it("fingerprints equivalent step input independently of object key order", () => {
    const step = planWorkspaceHostInitialization(request()).steps[0]!;
    expect(
      workspaceHostInitializationStepFingerprint({
        ...step,
        input: { hostId: "host-1", workspaceId: "workspace-1" },
      }),
    ).toBe(
      workspaceHostInitializationStepFingerprint({
        ...step,
        input: { workspaceId: "workspace-1", hostId: "host-1" },
      }),
    );
  });
});

describe("workspace-host credential lifecycle", () => {
  it("verifies every rotated binding before revoking its predecessor", () => {
    const plan = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: "rotate-1",
      workspaceId: "workspace-1",
      hostId: "host-1",
      requestedAt: REQUESTED_AT,
      deliveryCapabilities: CAPABLE,
      action: "rotate",
      currentCredentialRefs: refs("old"),
      currentDelivery: delivery(1),
      nextCredentialRefs: refs("new"),
      nextDelivery: delivery(2),
    });
    expect(plan.steps.slice(0, 4).map((step) => step.id)).toEqual([
      "bind-next-cloud",
      "verify-next-cloud",
      "revoke-previous-cloud",
      "verify-revoked-cloud",
    ]);
    expect(plan.steps[2].dependsOn).toEqual(["verify-next-cloud"]);
    expect(plan.steps[2].delivery.revocationRef).toBe("revoke-cloud-1");
    expect(plan.steps).toHaveLength(12);
  });

  it("plans explicit revocation and reconnect for the selected live channels", () => {
    const common = {
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      workspaceId: "workspace-1",
      hostId: "host-1",
      requestedAt: REQUESTED_AT,
      deliveryCapabilities: CAPABLE,
      currentCredentialRefs: refs(),
      currentDelivery: delivery(),
    } as const;
    const revoke = planWorkspaceHostCredentialLifecycle({
      ...common,
      operationId: "revoke-1",
      action: "revoke",
      channels: ["git", "agent"],
    });
    expect(revoke.steps.map((step) => step.id)).toEqual([
      "revoke-git",
      "verify-revoked-git",
      "revoke-agent",
      "verify-revoked-agent",
    ]);
    expect(revoke.steps[0]).toMatchObject({
      credentialRef: refs().gitCredentialRef,
      delivery: { revocationRef: "revoke-git-1" },
    });
    const reconnect = planWorkspaceHostCredentialLifecycle({
      ...common,
      operationId: "reconnect-1",
      action: "reconnect",
    });
    expect(reconnect.steps.filter((step) => step.kind === "bind")).toHaveLength(
      3,
    );
  });

  it("keeps references out of backups and requires all channels to rebind after restore", () => {
    const manifest = buildWorkspaceHostBackupCredentialManifest(
      "workspace-1",
      REQUESTED_AT,
      refs(),
      delivery(),
    );
    expect(manifest).toMatchObject({
      authorizationMaterial: "excluded",
      credentialReferences: "excluded",
      rebindRequired: WORKSPACE_HOST_CREDENTIAL_CHANNELS,
    });
    expect(manifest.bindingState.map((binding) => binding.generation)).toEqual([
      1, 1, 1,
    ]);
    const serializedBackup = JSON.stringify(manifest);
    expect(serializedBackup).not.toContain("resolver:");
    expect(serializedBackup).not.toContain("revoke-cloud-1");
    expect(serializedBackup).not.toContain("revoke-git-1");
    expect(serializedBackup).not.toContain("revoke-agent-1");

    const restoreBody = buildWorkspaceHostBackupRestoreCredentialRebindRequest(
      manifest,
      refs("restored"),
      delivery(2),
      REQUESTED_AT,
    );
    expect(restoreBody).toMatchObject({
      action: "restore-rebind",
      backup: manifest,
      nextCredentialRefs: refs("restored"),
      nextDelivery: delivery(2),
    });

    const restored = planWorkspaceHostCredentialLifecycle({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      operationId: "restore-1",
      workspaceId: "workspace-1",
      hostId: "host-1",
      requestedAt: REQUESTED_AT,
      deliveryCapabilities: CAPABLE,
      ...restoreBody,
    });
    expect(restored.steps.filter((step) => step.kind === "bind")).toHaveLength(
      3,
    );
    expect(() =>
      buildWorkspaceHostBackupRestoreCredentialRebindRequest(
        manifest,
        refs("same-generation"),
        delivery(1),
        REQUESTED_AT,
      ),
    ).toThrow(/Restore generation for cloud must increase/);
    const reusedRevocationRef = delivery(2);
    reusedRevocationRef.cloud.revocationRef = delivery().cloud.revocationRef;
    expect(() =>
      buildWorkspaceHostBackupRestoreCredentialRebindRequest(
        manifest,
        refs("reused-revocation"),
        reusedRevocationRef,
        REQUESTED_AT,
      ),
    ).toThrow(/Restore revocation reference for cloud must change/);
    expect(() =>
      planWorkspaceHostCredentialLifecycle({
        contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
        operationId: "restore-incomplete",
        workspaceId: "workspace-1",
        hostId: "host-1",
        requestedAt: REQUESTED_AT,
        deliveryCapabilities: CAPABLE,
        action: "restore-rebind",
        backup: manifest,
        nextCredentialRefs: { cloudCredentialRef: refs().cloudCredentialRef },
        nextDelivery: { cloud: delivery(2).cloud },
      }),
    ).toThrow(/rebind every currently bound credential channel/);
  });
});

describe("validateWorkspaceHostInitializationCanary", () => {
  function evidence(): WorkspaceHostInitializationCanaryEvidence {
    return {
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      kind: "live",
      runId: "canary-1",
      workspaceId: "workspace-1",
      hostId: "host-1",
      observedAt: "2026-08-22T10:15:00Z",
      repository: { visibility: "private", cloned: true },
      channels: {
        cloud: {
          bound: true,
          rotated: true,
          previousBindingRevoked: true,
          reconnected: true,
        },
        git: {
          bound: true,
          rotated: true,
          previousBindingRevoked: true,
          reconnected: true,
        },
        agent: {
          bound: true,
          rotated: true,
          previousBindingRevoked: true,
          reconnected: true,
        },
      },
      agents: {
        // WI-10002402: the kind each agent's probe table can actually emit.
        claude: { ready: true, verificationKind: "live-inference" },
        codex: { ready: true, verificationKind: "live-inference" },
        omp: { ready: true, verificationKind: "local-inference" },
      },
      backupRestore: {
        authorizationMaterial: "excluded",
        credentialReferences: "excluded",
        reboundChannels: ["cloud", "git", "agent"],
      },
    };
  }

  it("accepts only a live private-repository, three-channel, three-agent lifecycle proof", () => {
    expect(validateWorkspaceHostInitializationCanary(evidence())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("reports a missing agent and incomplete restore rebinding without raw logs", () => {
    const incomplete = evidence();
    // `agents` is Partial since coverage became declarable (D-369), so a fixture that intends to
    // degrade OMP must first prove OMP is actually present — otherwise this case could silently
    // become "OMP absent", which is a DIFFERENT assertion than "OMP not ready".
    const omp = incomplete.agents.omp;
    if (!omp) throw new Error("fixture must carry OMP evidence for this case");
    omp.ready = false as true;
    incomplete.backupRestore.reboundChannels = ["cloud", "git"];
    const result = validateWorkspaceHostInitializationCanary(incomplete);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "omp live readiness did not pass",
        "restore did not rebind all credential channels",
      ]),
    );
  });
});

/**
 * D-215 point 6 — a provider declaring `fileTransfer: false` cannot carry the git or agent
 * credential channels, and must be refused at PLAN time.
 *
 * The refusal these tests pin is the difference between a request rejected before anything is
 * provisioned and a VM that boots, initializes, and then fails inside `bind()` with
 * "delivered material ... is not present on the host" — a message that cannot distinguish a
 * provider that was never able to deliver from a delivery that was attempted and lost.
 */
describe("credential delivery capability gate", () => {
  /** Cloud-only: the one channel that is ambient, and therefore the exemption in D-215 point 4. */
  function cloudOnly(): Pick<
    WorkspaceHostInitializationRequest,
    "credentialRefs" | "credentialDelivery"
  > {
    return {
      credentialRefs: { cloudCredentialRef: refs().cloudCredentialRef },
      credentialDelivery: { cloud: delivery().cloud },
    };
  }

  it("refuses a git channel on a provider that cannot transfer files", () => {
    let thrown: unknown;
    try {
      planWorkspaceHostInitialization(
        request({
          deliveryCapabilities: NO_FILE_TRANSFER,
          credentialRefs: {
            cloudCredentialRef: refs().cloudCredentialRef,
            gitCredentialRef: refs().gitCredentialRef,
          },
          credentialDelivery: { cloud: delivery().cloud, git: delivery().git },
        }),
      );
    } catch (error) {
      thrown = error;
    }
    // A DISTINCT error type, not a generic validation message: an API edge must be able to tell
    // "this provider structurally cannot do this" from "your request body is malformed".
    expect(thrown).toBeInstanceOf(
      WorkspaceHostCredentialDeliveryCapabilityError,
    );
    expect(
      (thrown as WorkspaceHostCredentialDeliveryCapabilityError).channel,
    ).toBe("git");
    expect(
      (thrown as WorkspaceHostCredentialDeliveryCapabilityError).capability,
    ).toBe("fileTransfer");
  });

  it("refuses an agent channel on a provider that cannot transfer files", () => {
    expect(() =>
      planWorkspaceHostInitialization(
        request({
          deliveryCapabilities: NO_FILE_TRANSFER,
          credentialRefs: {
            cloudCredentialRef: refs().cloudCredentialRef,
            agentCredentialRef: refs().agentCredentialRef,
          },
          credentialDelivery: {
            cloud: delivery().cloud,
            agent: delivery().agent,
          },
        }),
      ),
    ).toThrow(WorkspaceHostCredentialDeliveryCapabilityError);
  });

  it("still plans the ambient cloud channel on that same provider", () => {
    // CALIBRATION. Without this the two refusals above are satisfied by a gate that rejects
    // everything, and the D-215 point 4 exemption would be untested — the exemption is what keeps
    // `bind()` from passing against a file we invented for a family that has none.
    const plan = planWorkspaceHostInitialization(
      request({ deliveryCapabilities: NO_FILE_TRANSFER, ...cloudOnly() }),
    );
    expect(plan.steps.map((step) => step.id)).toContain("bind-cloud");
    expect(plan.steps.some((step) => step.id === "bind-git")).toBe(false);
  });

  it("plans every channel when the provider declares file transfer", () => {
    // Positive control: the gate is off the path entirely for a capable provider.
    const plan = planWorkspaceHostInitialization(
      request({ deliveryCapabilities: CAPABLE }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual(
      expect.arrayContaining(["bind-cloud", "bind-git", "bind-agent"]),
    );
  });

  it("refuses an undeclared capability rather than assuming one", () => {
    // Fail-closed on a malformed declaration. An absent boolean must not read as "capable" —
    // that is exactly the decorative-boolean behaviour this decision exists to end.
    expect(() =>
      planWorkspaceHostInitialization(
        request({ deliveryCapabilities: {} as never, ...cloudOnly() }),
      ),
    ).toThrow(/deliveryCapabilities.fileTransfer must be declared/);
  });

  it("applies the same gate to every credential lifecycle action", () => {
    const base = {
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      workspaceId: "workspace-1",
      hostId: "host-1",
      requestedAt: REQUESTED_AT,
      deliveryCapabilities: NO_FILE_TRANSFER,
    } as const;
    expect(() =>
      planWorkspaceHostCredentialLifecycle({
        ...base,
        operationId: "rotate-x",
        action: "rotate",
        currentCredentialRefs: refs("old"),
        currentDelivery: delivery(),
        nextCredentialRefs: refs("new"),
        nextDelivery: delivery(2),
      }),
    ).toThrow(WorkspaceHostCredentialDeliveryCapabilityError);
    // Revocation too: if the provider could never place the file, there is no artifact for a
    // revoke to remove, and planning one would assert a cleanup that never had anything to clean.
    expect(() =>
      planWorkspaceHostCredentialLifecycle({
        ...base,
        operationId: "revoke-x",
        action: "revoke",
        currentCredentialRefs: refs(),
        currentDelivery: delivery(),
        channels: ["git"],
      }),
    ).toThrow(WorkspaceHostCredentialDeliveryCapabilityError);
  });
});

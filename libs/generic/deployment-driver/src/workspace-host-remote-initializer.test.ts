/**
 * Tests for the host-installed remote initializer (P-046 / WI-41711).
 *
 * The controller can only ever observe two things about this program: what it writes on stdout
 * and what exit code it leaves behind. So the tests are written against those two observables
 * wherever a behaviour is reachable from them, and against the engine directly only where the
 * distinction being asserted is finer than the wire can express.
 *
 * The seam that matters most here is the FAILURE channel. The protocol has exactly one success
 * word and no failure word, so every refusal below must show up as a non-zero exit with a clean
 * stdout — a `"failed"` envelope would be reported at the controller as a malformed response and
 * would misattribute the fault to the transport.
 */
import { describe, expect, it } from "vitest";

import {
  WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV,
  WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
  UnsupportedWorkspaceHostInitializationStepKindError,
  WorkspaceHostInitializationCanaryEvidenceError,
  WorkspaceHostRemoteInitializerProtocolError,
  assertWorkspaceHostRemoteInitializerArgv,
  buildWorkspaceHostInitializationCanaryEvidence,
  encodeWorkspaceHostCredentialLifecycleStep,
  executeWorkspaceHostRemoteInitializerStep,
  handleWorkspaceHostRemoteInitializerPayload,
  parseWorkspaceHostRemoteInitializerRequest,
  type BuildWorkspaceHostInitializationCanaryEvidenceInput,
  type WorkspaceHostRemoteInitializerDeps,
  type WorkspaceHostRemoteInitializerHost,
} from "./workspace-host-remote-initializer";
import {
  readAllStdin,
  runWorkspaceHostRemoteInitializerCli,
} from "./workspace-host-remote-initializer-cli";
import {
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  WORKSPACE_HOST_INITIALIZATION_STEP_KINDS,
  planWorkspaceHostCredentialLifecycle,
  type WorkspaceHostCredentialChannel,
  type WorkspaceHostCredentialDeliverySet,
} from "./workspace-host-initialization";
import type { WorkspaceHostCredentialRefs } from "./workspace-host-types";
import {
  WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
  WORKSPACE_HOST_CANARY_AGENTS,
  type WorkspaceHostAgentVerificationEvidence,
  type WorkspaceHostAgentVerificationReport,
  type WorkspaceHostCanaryAgent,
} from "./workspace-host-agent-authentication";
import {
  WorkspaceHostCredentialResolver,
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  type WorkspaceHostCredentialBindingDescriptor,
  type WorkspaceHostCredentialMaterializer,
} from "./workspace-host-credential-namespace";

const NOW = "2026-08-25T22:00:00.000Z";
const EXPIRES_AT = "2026-08-25T23:00:00.000Z";
const PROTOCOL = WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION;

/* ------------------------------------------------------------------------------------------ */
/* Fixtures                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * A clock that advances one second per read, so "was this stamped before or after the handler
 * ran" is a question the tests can actually answer. A frozen clock would make the two
 * indistinguishable and would have passed against the bug this ordering exists to prevent.
 */
function tickingClock(startIso = NOW): { now: () => Date; reads: number } {
  const base = Date.parse(startIso);
  const state = { reads: 0 };
  return {
    get reads() {
      return state.reads;
    },
    now: () => new Date(base + state.reads++ * 1000),
  };
}

function agentEvidence(
  agent: WorkspaceHostCanaryAgent,
  ready: boolean,
): WorkspaceHostAgentVerificationEvidence {
  // WI-10002402: claude/codex cannot emit `authenticated-account` — claude's probe was removed as
  // forgeable (WI-10001689) and codex's is `satisfiesReadiness: false`. This fixture described
  // evidence no host can produce, which is why the suite passed while real canaries were refused.
  const verificationKind = agent === "omp" ? "local-inference" : "live-inference";
  return {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    agent,
    ready,
    verificationKind,
    endpoint: `${agent}-whoami`,
    exitStatus: ready ? 0 : 1,
    observedAt: NOW,
    subjectDisclosure: "digest",
    ...(ready ? { proofDigest: `${agent}0123456789abcd` } : {}),
    ...(ready ? {} : { failure: "no-verification-proof" as const }),
  };
}

function agentReport(
  overrides: Partial<Record<WorkspaceHostCanaryAgent, boolean>> = {},
): WorkspaceHostAgentVerificationReport {
  const agents = Object.fromEntries(
    WORKSPACE_HOST_CANARY_AGENTS.map((agent) => [
      agent,
      agentEvidence(agent, overrides[agent] ?? true),
    ]),
  ) as WorkspaceHostAgentVerificationReport["agents"];
  return {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    observedAt: NOW,
    allReady: WORKSPACE_HOST_CANARY_AGENTS.every(
      (agent) => agents[agent]?.ready === true,
    ),
    agents,
  };
}

/** Records which seam each step reached, so "all six kinds dispatch" is a real assertion. */
class RecordingHost implements WorkspaceHostRemoteInitializerHost {
  readonly calls: Array<{ readonly op: string; readonly input: unknown }> = [];

  constructor(
    private readonly options: {
      readonly agents?: WorkspaceHostAgentVerificationReport;
      readonly repository?: {
        visibility: "public" | "private";
        cloned: boolean;
      };
      readonly evidence?: Record<string, unknown>;
      readonly clock?: () => Date;
    } = {},
  ) {}

  private record(op: string, input: unknown): Promise<Record<string, unknown>> {
    // Reading the shared clock here is what lets a test prove `observedAt` was stamped after the
    // handler finished rather than when the request was parsed.
    const ranAt = this.options.clock?.().toISOString();
    this.calls.push({ op, input });
    return Promise.resolve({
      ...(this.options.evidence ?? { op }),
      ...(ranAt ? { ranAt } : {}),
    });
  }

  createWorkspace(input: unknown) {
    return this.record("createWorkspace", input);
  }
  verifyRetainedWorkspace(input: unknown) {
    return this.record("verifyRetainedWorkspace", input);
  }
  installDesktopPack(input: { hostId: string }) {
    return this.record("installDesktopPack", input);
  }
  cloneRepository(input: unknown) {
    return this.record("cloneRepository", input);
  }
  pairWorkspace(input: unknown) {
    return this.record("pairWorkspace", input);
  }
  importWorkspace(input: unknown) {
    return this.record("importWorkspace", input);
  }
  probeAgentVerification(requestedAgents?: readonly WorkspaceHostCanaryAgent[]): Promise<WorkspaceHostAgentVerificationReport> {
    this.calls.push({ op: "probeAgentVerification", input: requestedAgents });
    return Promise.resolve(this.options.agents ?? agentReport());
  }
  describeClonedRepository(input?: {
    destination: string;
    visibility: "public" | "private";
  }) {
    this.calls.push({ op: "describeClonedRepository", input });
    return Promise.resolve(
      this.options.repository ?? {
        visibility: "private" as const,
        cloned: true,
      },
    );
  }
}

class RecordingMaterializer implements WorkspaceHostCredentialMaterializer {
  readonly calls: string[] = [];

  constructor(
    readonly family: WorkspaceHostCredentialBindingDescriptor["family"],
  ) {}

  private record(
    op: string,
    binding: WorkspaceHostCredentialBindingDescriptor,
  ) {
    this.calls.push(`${op}:${binding.channel}:g${binding.generation}`);
    return Promise.resolve({ boundAt: NOW });
  }
  bind(b: WorkspaceHostCredentialBindingDescriptor) {
    return this.record("bind", b);
  }
  verifyBound(b: WorkspaceHostCredentialBindingDescriptor) {
    return this.record("verify-bound", b);
  }
  revoke(b: WorkspaceHostCredentialBindingDescriptor) {
    return this.record("revoke", b);
  }
  verifyRevoked(b: WorkspaceHostCredentialBindingDescriptor) {
    return this.record("verify-revoked", b);
  }
}

const GIT_FIELDS = {
  forge: "github",
  owner: "papercupai",
  repository: "papercusp-byoc-canary",
};

function gitBindInput(generation = 1) {
  return {
    channel: "git",
    credentialRef: {
      kind: "git",
      ref: buildWorkspaceHostCredentialReference(
        "git-short-lived-delegation",
        GIT_FIELDS,
      ),
    },
    delivery: {
      kind: "short-lived-delegation",
      generation,
      audience: "pc-byoc-canary-01-vm",
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        "git-short-lived-delegation",
        GIT_FIELDS,
        generation,
      ),
      expiresAt: EXPIRES_AT,
    },
  };
}

const CLOUD_FIELDS = {
  provider: "gcp",
  scopeId: "active-alcove-504205-q3",
  workloadId: "pc-byoc-canary-01",
};
const AGENT_FIELDS = { hostId: "byoc-canary-01", agentSet: "claude-codex-omp" };

/**
 * A COMPLETE three-channel credential set, built from real parseable references.
 *
 * The initialization tests next door can use opaque strings like `git-resolver:v1` because the
 * planner never parses a reference. The lifecycle round-trip does — it runs the resolver, which
 * parses the reference to pick a materializer — so these have to be genuine.
 */
function lifecycleRefs(): WorkspaceHostCredentialRefs {
  return {
    cloudCredentialRef: {
      kind: "cloud",
      ref: buildWorkspaceHostCredentialReference(
        "cloud-workload-identity",
        CLOUD_FIELDS,
      ),
    },
    gitCredentialRef: {
      kind: "git",
      ref: buildWorkspaceHostCredentialReference(
        "git-short-lived-delegation",
        GIT_FIELDS,
      ),
    },
    agentCredentialRef: {
      kind: "agent",
      ref: buildWorkspaceHostCredentialReference(
        "agent-forwarded-reference",
        AGENT_FIELDS,
      ),
    },
  };
}

function lifecycleDelivery(generation = 1): WorkspaceHostCredentialDeliverySet {
  return {
    cloud: {
      kind: "provider-identity",
      generation,
      audience: "pc-byoc-canary-01-vm",
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        "cloud-workload-identity",
        CLOUD_FIELDS,
        generation,
      ),
    },
    git: {
      kind: "short-lived-delegation",
      generation,
      audience: "pc-byoc-canary-01-vm",
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        "git-short-lived-delegation",
        GIT_FIELDS,
        generation,
      ),
      expiresAt: EXPIRES_AT,
    },
    agent: {
      kind: "forwarded-agent",
      generation,
      audience: "pc-byoc-canary-01-vm",
      revocationRef: buildWorkspaceHostCredentialRevocationReference(
        "agent-forwarded-reference",
        AGENT_FIELDS,
        generation,
      ),
    },
  };
}

/** Valid `input` for each of the six step kinds — the table every dispatch test walks. */
const STEP_INPUTS: Record<string, Record<string, unknown>> = {
  "install-desktop-pack": { hostId: "byoc-canary-01" },
  "create-workspace": { workspaceId: "ws-1", hostId: "byoc-canary-01" },
  "verify-retained-workspace": { workspaceId: "ws-1", hostId: "byoc-canary-01", tenantIdentity: "a".repeat(64) },
  "clone-repository": {
    repositoryUrl: "https://github.com/Papercusp/papercusp-byoc-canary.git",
    visibility: "private",
    destination: "/srv/workspace/repo",
    credentialChannel: "git",
  },
  "pair-workspace": {
    sourceWorkspaceId: "ws-source",
    pairingReference: { kind: "pairing", ref: "pair-abc" },
    include: ["repositories"],
  },
  "import-workspace": {
    sourceWorkspaceId: "ws-source",
    sourceSnapshotRef: "snap-1",
    include: ["files"],
  },
  "bind-credential": gitBindInput(),
  "verify-initialization": {
    sourceKind: "git",
    requiredChannels: ["cloud", "git", "agent"],
    repository: { destination: "repositories/private", visibility: "private" },
  },
  // The four credential-lifecycle kinds (D-114). They take the SAME flattened input as
  // bind-credential, which is the property that lets one wire envelope serve both families.
  bind: gitBindInput(),
  "verify-bound": gitBindInput(),
  revoke: gitBindInput(),
  "verify-revoked": gitBindInput(),
};

/** The host seam (or resolver) each kind must reach. */
const EXPECTED_SEAM: Record<string, string> = {
  "create-workspace": "createWorkspace",
  "verify-retained-workspace": "verifyRetainedWorkspace",
  "clone-repository": "cloneRepository",
  "pair-workspace": "pairWorkspace",
  "import-workspace": "importWorkspace",
  "verify-initialization": "probeAgentVerification",
};

function step(
  kind: string,
  input?: Record<string, unknown>,
  id = `step-${kind}`,
) {
  return {
    id,
    kind,
    dependsOn: [] as string[],
    idempotencyKey: `${id}-key`,
    input: input ?? STEP_INPUTS[kind] ?? {},
  };
}

function request(kind: string, input?: Record<string, unknown>, id?: string) {
  return { protocolVersion: PROTOCOL, step: step(kind, input, id) };
}

describe("optional desktop pack wire admission", () => {
  it("dispatches the fixed installer through the ordinary JSON protocol", async () => {
    const deps = makeDeps();
    const result = JSON.parse(await handleWorkspaceHostRemoteInitializerPayload(
      JSON.stringify(request("install-desktop-pack")), deps,
    ));
    expect(result.status).toBe("succeeded");
    expect(deps.host.calls).toEqual([{ op: "installDesktopPack", input: { hostId: "byoc-canary-01" } }]);
  });

  it.each(["script", "artifact", "isolation"])("refuses caller-controlled %s before touching the host", async (key) => {
    const deps = makeDeps();
    await expect(handleWorkspaceHostRemoteInitializerPayload(JSON.stringify(request(
      "install-desktop-pack", { hostId: "host-1", [key]: "untrusted" },
    )), deps)).rejects.toThrow(/accepts only/);
    expect(deps.host.calls).toEqual([]);
  });

  it("rejects a prior protocol before any host operation", async () => {
    const deps = makeDeps();
    await expect(handleWorkspaceHostRemoteInitializerPayload(JSON.stringify({
      ...request("install-desktop-pack"), protocolVersion: "papercusp-gcp-iap-initialization-v3",
    }), deps)).rejects.toThrow(/unsupported protocol version/);
    expect(deps.host.calls).toEqual([]);
  });

  it("rejects a host label that cannot be safely represented in the pack attestation", async () => {
    const deps = makeDeps();
    await expect(handleWorkspaceHostRemoteInitializerPayload(JSON.stringify(request(
      "install-desktop-pack", { hostId: 'bad"host' },
    )), deps)).rejects.toThrow(/invalid desktop-pack hostId/);
    expect(deps.host.calls).toEqual([]);
  });
});

function makeDeps(
  options: {
    readonly host?: RecordingHost;
    readonly clock?: () => Date;
  } = {},
): WorkspaceHostRemoteInitializerDeps & {
  readonly host: RecordingHost;
  readonly materializers: Readonly<Record<string, RecordingMaterializer>>;
} {
  const host = options.host ?? new RecordingHost();
  // Kept addressable (rather than inlined into the resolver) so a lifecycle test can assert the
  // ORDER of operations a plan produced — which is the whole point of a rotate plan.
  const materializers = {
    "cloud-workload-identity": new RecordingMaterializer(
      "cloud-workload-identity",
    ),
    "git-short-lived-delegation": new RecordingMaterializer(
      "git-short-lived-delegation",
    ),
    "agent-forwarded-reference": new RecordingMaterializer(
      "agent-forwarded-reference",
    ),
    "agent-encrypted-reference": new RecordingMaterializer(
      "agent-encrypted-reference",
    ),
  } as const;
  const resolver = new WorkspaceHostCredentialResolver(
    Object.values(materializers),
  );
  return {
    host,
    materializers,
    credentials: resolver,
    now: options.clock ?? (() => new Date(NOW)),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Request parsing                                                                              */
/* ------------------------------------------------------------------------------------------ */

describe("parseWorkspaceHostRemoteInitializerRequest", () => {
  it("accepts a well-formed envelope for every declared step kind", () => {
    for (const kind of WORKSPACE_HOST_INITIALIZATION_STEP_KINDS) {
      const parsed = parseWorkspaceHostRemoteInitializerRequest(request(kind));
      expect(parsed.protocolVersion).toBe(PROTOCOL);
      expect(parsed.step.kind).toBe(kind);
      expect(parsed.step.id).toBe(`step-${kind}`);
    }
  });

  it("rejects a protocol version it does not speak, naming both versions", () => {
    // v1 is the PREDECESSOR, and using it here is the point: a host or controller packaged
    // before credential-lifecycle carriage landed (D-114) must be rejected as a version skew,
    // loudly and by name, rather than getting as far as an unrecognised step kind.
    expect(() =>
      parseWorkspaceHostRemoteInitializerRequest({
        protocolVersion: "papercusp-gcp-iap-initialization-v1",
        step: step("create-workspace"),
      }),
    ).toThrow(WorkspaceHostRemoteInitializerProtocolError);
    expect(() =>
      parseWorkspaceHostRemoteInitializerRequest({
        protocolVersion: "papercusp-gcp-iap-initialization-v1",
        step: step("create-workspace"),
      }),
    ).toThrow(
      /unsupported protocol version 'papercusp-gcp-iap-initialization-v1'.*v4/s,
    );
  });

  it("checks the protocol version BEFORE any other field", () => {
    // A version-skewed envelope whose step is also malformed must be reported as a version skew:
    // every later assumption in the parser belongs to the version it could not confirm.
    expect(() =>
      parseWorkspaceHostRemoteInitializerRequest({
        protocolVersion: "other",
        step: "not-an-object",
      }),
    ).toThrow(/unsupported protocol version/);
  });

  it.each([
    ["a non-object request", "nope"],
    ["a null request", null],
    ["an array request", []],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseWorkspaceHostRemoteInitializerRequest(raw)).toThrow(
      WorkspaceHostRemoteInitializerProtocolError,
    );
  });

  it("rejects an unknown step kind with the dedicated error, listing what it supports", () => {
    let caught: unknown;
    try {
      parseWorkspaceHostRemoteInitializerRequest(request("teleport-workspace"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(
      UnsupportedWorkspaceHostInitializationStepKindError,
    );
    expect(
      (caught as UnsupportedWorkspaceHostInitializationStepKindError).kind,
    ).toBe("teleport-workspace");
    for (const kind of WORKSPACE_HOST_INITIALIZATION_STEP_KINDS) {
      expect((caught as Error).message).toContain(kind);
    }
  });

  it.each([
    ["id", { id: "" }],
    ["kind", { kind: "" }],
    ["idempotencyKey", { idempotencyKey: "" }],
  ])(
    "rejects a step whose %s is missing, as a protocol error",
    (_label, patch) => {
      // An ABSENT kind is a malformed envelope, not an unrecognised step: reporting it as
      // "no handler for step kind ''" would send a reader looking for a handler to write.
      const raw = {
        protocolVersion: PROTOCOL,
        step: { ...step("create-workspace"), ...patch },
      };
      expect(() => parseWorkspaceHostRemoteInitializerRequest(raw)).toThrow(
        WorkspaceHostRemoteInitializerProtocolError,
      );
    },
  );

  it("distinguishes a missing kind from an unsupported one", () => {
    const missing = {
      protocolVersion: PROTOCOL,
      step: { ...step("create-workspace"), kind: "" },
    };
    expect(() => parseWorkspaceHostRemoteInitializerRequest(missing)).toThrow(
      /request.step.kind must be a non-empty string/,
    );
    expect(() =>
      parseWorkspaceHostRemoteInitializerRequest(request("teleport-workspace")),
    ).toThrow(UnsupportedWorkspaceHostInitializationStepKindError);
  });

  it("requires dependsOn to be an array and input to be an object", () => {
    expect(() =>
      parseWorkspaceHostRemoteInitializerRequest({
        protocolVersion: PROTOCOL,
        step: { ...step("create-workspace"), dependsOn: "step-0" },
      }),
    ).toThrow(/dependsOn must be an array/);
    expect(() =>
      parseWorkspaceHostRemoteInitializerRequest({
        protocolVersion: PROTOCOL,
        step: { ...step("create-workspace"), input: "workspaceId=ws-1" },
      }),
    ).toThrow(/request.step.input must be an object/);
  });

  it("refuses a request that already carries secret-shaped material", () => {
    // The host must not act on a request containing material it should never have seen. Both ends
    // assert this, so whichever end introduced the leak is the one that fails loudly.
    expect(() =>
      parseWorkspaceHostRemoteInitializerRequest(
        request("create-workspace", {
          workspaceId: "ws-1",
          hostId: "byoc-canary-01",
          accessToken: "ya29.redacted",
        }),
      ),
    ).toThrow(/Secret-shaped field .*accessToken.* is forbidden/);
  });

  it("preserves dependsOn and idempotencyKey onto the parsed step", () => {
    const parsed = parseWorkspaceHostRemoteInitializerRequest({
      protocolVersion: PROTOCOL,
      step: {
        ...step("create-workspace"),
        dependsOn: ["step-0"],
        idempotencyKey: "idem-7",
      },
    });
    expect(parsed.step.dependsOn).toEqual(["step-0"]);
    expect(parsed.step.idempotencyKey).toBe("idem-7");
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Step execution — all six kinds                                                               */
/* ------------------------------------------------------------------------------------------ */

describe("executeWorkspaceHostRemoteInitializerStep", () => {
  it("dispatches every declared step kind to its own seam and answers succeeded", async () => {
    // Walking WORKSPACE_HOST_INITIALIZATION_STEP_KINDS rather than a hand-written list means a
    // seventh kind added to the contract fails here instead of silently going unhandled.
    for (const kind of WORKSPACE_HOST_INITIALIZATION_STEP_KINDS) {
      const deps = makeDeps();
      const response = await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request(kind)),
        deps,
      );
      expect(response.status).toBe("succeeded");
      expect(response.protocolVersion).toBe(PROTOCOL);
      expect(response.stepId).toBe(`step-${kind}`);
      expect(Number.isFinite(Date.parse(response.observedAt))).toBe(true);
      const seam = EXPECTED_SEAM[kind];
      if (seam) expect(deps.host.calls.map((call) => call.op)).toContain(seam);
    }
  });

  it("refuses retained admission on old adapters and malformed tenant identity without creating data", async () => {
    const deps = makeDeps();
    deps.host.verifyRetainedWorkspace = undefined as never;
    await expect(executeWorkspaceHostRemoteInitializerStep(
      parseWorkspaceHostRemoteInitializerRequest(request("verify-retained-workspace")), deps,
    )).rejects.toThrow(UnsupportedWorkspaceHostInitializationStepKindError);
    expect(deps.host.calls).toEqual([]);
    await expect(executeWorkspaceHostRemoteInitializerStep(
      parseWorkspaceHostRemoteInitializerRequest(request("verify-retained-workspace", { tenantIdentity: "foreign" })), makeDeps(),
    )).rejects.toThrow(/tenant identity/);
  });

  it("passes create-workspace identifiers straight through", async () => {
    const deps = makeDeps();
    await executeWorkspaceHostRemoteInitializerStep(
      parseWorkspaceHostRemoteInitializerRequest(request("create-workspace")),
      deps,
    );
    expect(deps.host.calls[0]).toEqual({
      op: "createWorkspace",
      input: { workspaceId: "ws-1", hostId: "byoc-canary-01" },
    });
  });

  it("stamps observedAt AFTER the handler returns, not when the request was parsed", async () => {
    const clock = tickingClock();
    const host = new RecordingHost({ clock: clock.now });
    const deps = makeDeps({ host, clock: clock.now });
    const response = await executeWorkspaceHostRemoteInitializerStep(
      parseWorkspaceHostRemoteInitializerRequest(request("create-workspace")),
      deps,
    );
    const ranAt = (response.publicEvidence as { ranAt: string }).ranAt;
    expect(Date.parse(response.observedAt)).toBeGreaterThan(Date.parse(ranAt));
  });

  it("omits publicEvidence entirely when a handler produced none", async () => {
    const deps = makeDeps({ host: new RecordingHost({ evidence: {} }) });
    const response = await executeWorkspaceHostRemoteInitializerStep(
      parseWorkspaceHostRemoteInitializerRequest(request("create-workspace")),
      deps,
    );
    expect(response).not.toHaveProperty("publicEvidence");
  });

  it("refuses to emit a response whose evidence carries secret-shaped material", async () => {
    const deps = makeDeps({
      host: new RecordingHost({ evidence: { apiKey: "abc" } }),
    });
    await expect(
      executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("create-workspace")),
        deps,
      ),
    ).rejects.toThrow(/Secret-shaped field .*apiKey.* is forbidden/);
  });

  describe("clone-repository", () => {
    it("refuses a private clone that does not name a credential channel", async () => {
      // Left to git, this fails as "repository not found", which reads like a wrong URL rather
      // than a missing binding — so the refusal has to happen before the fetch.
      const deps = makeDeps();
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("clone-repository", {
              repositoryUrl:
                "https://github.com/Papercusp/papercusp-byoc-canary.git",
              visibility: "private",
              destination: "/srv/workspace/repo",
            }),
          ),
          deps,
        ),
      ).rejects.toThrow(/private clone step must name the credential channel/);
      expect(deps.host.calls).toHaveLength(0);
    });

    it("allows a public clone with no credential channel", async () => {
      const deps = makeDeps();
      const response = await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(
          request("clone-repository", {
            repositoryUrl: "https://github.com/papercupai/public.git",
            visibility: "public",
            destination: "/srv/workspace/repo",
          }),
        ),
        deps,
      );
      expect(response.status).toBe("succeeded");
      expect(deps.host.calls[0]?.input).not.toHaveProperty("credentialChannel");
    });

    it("rejects a visibility that is neither public nor private", async () => {
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("clone-repository", {
              repositoryUrl: "https://example.invalid/repo.git",
              visibility: "internal",
              destination: "/srv/workspace/repo",
            }),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/visibility must be 'public' or 'private'/);
    });

    it("rejects a credentialChannel that is not a declared channel", async () => {
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("clone-repository", {
              repositoryUrl: "https://example.invalid/repo.git",
              visibility: "private",
              destination: "/srv/workspace/repo",
              credentialChannel: "ssh",
            }),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/'ssh' is not a credential channel/);
    });

    it("forwards revision only when the step carried one", async () => {
      const withRevision = makeDeps();
      await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(
          request("clone-repository", {
            ...STEP_INPUTS["clone-repository"],
            revision: "abc123",
          }),
        ),
        withRevision,
      );
      expect(withRevision.host.calls[0]?.input).toMatchObject({
        revision: "abc123",
        credentialChannel: "git",
      });

      const withoutRevision = makeDeps();
      await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("clone-repository")),
        withoutRevision,
      );
      expect(withoutRevision.host.calls[0]?.input).not.toHaveProperty(
        "revision",
      );
    });
  });

  describe("pair-workspace and import-workspace", () => {
    it("requires the pairing reference to declare kind pairing", async () => {
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("pair-workspace", {
              sourceWorkspaceId: "ws-source",
              pairingReference: { kind: "snapshot", ref: "pair-abc" },
              include: ["repositories"],
            }),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/pairingReference.kind must be 'pairing'/);
    });

    it("requires include to be an array of strings", async () => {
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("import-workspace", {
              sourceWorkspaceId: "ws-source",
              sourceSnapshotRef: "snap-1",
              include: ["files", 7],
            }),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/include must be an array of strings/);
    });

    it("forwards the pairing and import inputs verbatim", async () => {
      const pairing = makeDeps();
      await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("pair-workspace")),
        pairing,
      );
      expect(pairing.host.calls[0]?.input).toEqual({
        sourceWorkspaceId: "ws-source",
        pairingReference: { kind: "pairing", ref: "pair-abc" },
        include: ["repositories"],
      });

      const importing = makeDeps();
      await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("import-workspace")),
        importing,
      );
      expect(importing.host.calls[0]?.input).toEqual({
        sourceWorkspaceId: "ws-source",
        sourceSnapshotRef: "snap-1",
        include: ["files"],
      });
    });
  });

  describe("bind-credential", () => {
    it("binds through the resolver and publishes only non-reversible evidence", async () => {
      const deps = makeDeps();
      const response = await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("bind-credential")),
        deps,
      );
      // The revocation reference and the raw credential reference are deliberately NOT
      // republished into the receipt; the digest is what proves a binding changed.
      expect(Object.keys(response.publicEvidence ?? {}).sort()).toEqual([
        "audience",
        "channel",
        "deliveryKind",
        "detail",
        "family",
        "generation",
        "operation",
        "referenceDigest",
      ]);
      expect(response.publicEvidence).toMatchObject({
        channel: "git",
        family: "git-short-lived-delegation",
        deliveryKind: "short-lived-delegation",
        generation: 1,
        audience: "pc-byoc-canary-01-vm",
      });
      expect(
        String(
          (response.publicEvidence as { referenceDigest: string })
            .referenceDigest,
        ),
      ).not.toContain("papercusp-byoc-canary");
    });

    it("judges expiry against the delivery window rather than the host clock", async () => {
      // requestedAt is derived as one millisecond before now, so a delegation that expired before
      // the host looked at it is refused here instead of being bound and failing later.
      const expired = {
        ...gitBindInput(),
        delivery: {
          ...gitBindInput().delivery,
          expiresAt: "2026-08-25T21:00:00.000Z",
        },
      };
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("bind-credential", expired),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/expiresAt must be after requestedAt/);
    });

    it("refuses a revocation reference that names a different generation", async () => {
      const skewed = {
        ...gitBindInput(1),
        delivery: { ...gitBindInput(1).delivery, generation: 2 },
      };
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("bind-credential", skewed),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/names generation 1 but the delivery is generation 2/);
    });

    it("rejects a channel that is not a declared credential channel", async () => {
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("bind-credential", { ...gitBindInput(), channel: "ssh" }),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/'ssh' is not a credential channel/);
    });
  });

  describe("credential-lifecycle steps (D-114)", () => {
    // WHY THIS BLOCK EXISTS. The lifecycle planner and executor were both complete and the host
    // resolver already had executeLifecycleStep, but the wire carried only the six
    // initialization kinds — so a planned rotation could not reach a host, and
    // validateWorkspaceHostInitializationCanary (which demands bound + rotated +
    // previousBindingRevoked + reconnected on every channel) was unsatisfiable BY CONSTRUCTION.
    // These tests pin the carriage that closes that.

    it("treats the step kind AS the credential operation, with no mapping table", () => {
      // The dispatch in executeWorkspaceHostRemoteInitializerStep passes `step.kind` straight
      // through as the operation. That is only sound while the two lists are identical, and a
      // comment asserting it would rot silently — so the identity is measured here instead.
      expect(
        [...WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS].sort(),
      ).toEqual(["bind", "revoke", "verify-bound", "verify-revoked"].sort());
    });

    it("accepts every lifecycle kind on the wire and reaches the matching resolver operation", async () => {
      for (const kind of WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS) {
        const deps = makeDeps();
        const response = await executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(request(kind)),
          deps,
        );
        expect(response.status).toBe("succeeded");
        // The receipt names WHICH operation ran. Without this a rotation's four receipts would
        // be indistinguishable from four binds, and the canary's `rotated` /
        // `previousBindingRevoked` flags could not be evidenced from receipts at all.
        expect(
          (response.publicEvidence as { operation: string }).operation,
        ).toBe(kind);
      }
    });

    it("carries a planner-produced revocation end to end, in dependency order", async () => {
      // A full plan, encoded by the driver's own encoder, parsed by the driver's own parser, and
      // executed against the resolver — the round trip the controller will perform.
      const plan = planWorkspaceHostCredentialLifecycle({
        contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
        operationId: "revoke-wire-1",
        deliveryCapabilities: { fileTransfer: true },
        workspaceId: "ws-1",
        hostId: "byoc-canary-01",
        requestedAt: NOW,
        action: "revoke",
        currentCredentialRefs: lifecycleRefs(),
        currentDelivery: lifecycleDelivery(1),
        channels: ["git"],
      });
      expect(plan.steps.map((s) => s.id)).toEqual([
        "revoke-git",
        "verify-revoked-git",
      ]);

      const deps = makeDeps();
      for (const planned of plan.steps) {
        const response = await executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest({
            protocolVersion: PROTOCOL,
            step: encodeWorkspaceHostCredentialLifecycleStep(planned),
          }),
          deps,
        );
        expect(response.stepId).toBe(planned.id);
      }

      // The resolver saw revoke THEN verify-revoked, on the git channel, at generation 1 — which
      // is exactly the ordering the planner encoded and the wire had to preserve.
      expect(deps.materializers["git-short-lived-delegation"].calls).toEqual([
        "revoke:git:g1",
        "verify-revoked:git:g1",
      ]);
      // And no OTHER channel was touched: a revoke scoped to ['git'] must not disturb the cloud
      // or agent bindings the host is still running on.
      expect(deps.materializers["cloud-workload-identity"].calls).toEqual([]);
      expect(deps.materializers["agent-forwarded-reference"].calls).toEqual([]);
    });

    it("rejects a lifecycle step naming something that is not a credential channel", async () => {
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("revoke", { ...gitBindInput(), channel: "database" }),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/'database' is not a credential channel/);
    });

    it("never republishes the revocation reference or the raw credential reference", async () => {
      // Same allowlist as bind-credential — asserted separately because a lifecycle receipt is
      // produced on the revoke path too, where a leaked revocationRef would be equally fatal.
      const deps = makeDeps();
      const response = await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("revoke")),
        deps,
      );
      const serialized = JSON.stringify(response.publicEvidence);
      expect(serialized).not.toContain(gitBindInput().delivery.revocationRef);
      expect(serialized).not.toContain("papercusp-byoc-canary");
    });
  });

  describe("verify-initialization", () => {
    it("passes explicit coverage to the host and records excluded agents as unverified", async () => {
      const requestedAgents = ["claude", "omp"] as const;
      const host = new RecordingHost({ agents: {
        ...agentReport(), requestedAgents, allReady: false,
        agents: { claude: agentEvidence("claude", true), omp: agentEvidence("omp", true) },
      } });
      const response = await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("verify-initialization", {
          sourceKind: "empty", requiredChannels: ["agent"], requestedAgents,
        })), makeDeps({ host }),
      );
      expect(host.calls).toContainEqual({ op: "probeAgentVerification", input: requestedAgents });
      expect(response.publicEvidence).toMatchObject({ requestedAgents, allReady: false });
      expect((response.publicEvidence?.agents as Record<string, unknown>).codex).toBeUndefined();
    });

    it("rejects a host report that did not honor requested-agent coverage", async () => {
      await expect(executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("verify-initialization", {
          sourceKind: "empty", requiredChannels: ["agent"], requestedAgents: ["claude", "omp"],
        })), makeDeps(),
      )).rejects.toThrow(/coverage/);
    });

    it("rejects empty coverage before probing and refuses the pre-selection wire protocol", async () => {
      const host = new RecordingHost();
      await expect(executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(request("verify-initialization", {
          sourceKind: "empty", requiredChannels: ["agent"], requestedAgents: [],
        })), makeDeps({ host }),
      )).rejects.toThrow(/requestedAgents/);
      expect(host.calls).toEqual([]);
      expect(() => parseWorkspaceHostRemoteInitializerRequest({
        ...request("verify-initialization"), protocolVersion: "papercusp-gcp-iap-initialization-v2",
      })).toThrow(/unsupported protocol version/);
    });

    it("publishes the agent report and repository observation as evidence", async () => {
      const deps = makeDeps();
      const response = await executeWorkspaceHostRemoteInitializerStep(
        parseWorkspaceHostRemoteInitializerRequest(
          request("verify-initialization"),
        ),
        deps,
      );
      expect(response.publicEvidence).toMatchObject({
        sourceKind: "git",
        requiredChannels: ["cloud", "git", "agent"],
        repository: { visibility: "private", cloned: true },
        agentContractVersion:
          WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
      });
      const agents = (
        response.publicEvidence as {
          agents: Record<string, { ready: boolean }>;
        }
      ).agents;
      for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
        expect(agents[agent].ready).toBe(true);
      }
      expect(deps.host.calls).toContainEqual({
        op: "describeClonedRepository",
        input: { destination: "repositories/private", visibility: "private" },
      });
    });

    it("THROWS when an agent is not ready, rather than reporting it in evidence", async () => {
      // This is the whole point of the step: a green verdict backed by a boolean nobody checked
      // is the defect being removed, so the failure must stop the run, not decorate it.
      const deps = makeDeps({
        host: new RecordingHost({ agents: agentReport({ codex: false }) }),
      });
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("verify-initialization"),
          ),
          deps,
        ),
      ).rejects.toThrow(/agent readiness did not pass for: codex/);
    });

    it("names every unready agent, not just the first", async () => {
      const deps = makeDeps({
        host: new RecordingHost({
          agents: agentReport({ claude: false, omp: false }),
        }),
      });
      // Each agent now carries its REASON CODE (WI-2144034), so the names are no longer adjacent.
      // Asserted separately rather than as one loosened pattern: the point of this test is that
      // BOTH agents are named, and a single relaxed regex could pass while one of them vanished.
      const rejects = expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("verify-initialization"),
          ),
          deps,
        ),
      ).rejects;
      await rejects.toThrow(/\bclaude \(/);
      await rejects.toThrow(/\bomp \(/);
    });

    it("requires requiredChannels to be an array of strings", async () => {
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("verify-initialization", {
              sourceKind: "git",
              requiredChannels: "git",
            }),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/requiredChannels must be an array of strings/);
    });

    it("requires a repository destination and visibility for a git source", async () => {
      await expect(
        executeWorkspaceHostRemoteInitializerStep(
          parseWorkspaceHostRemoteInitializerRequest(
            request("verify-initialization", {
              sourceKind: "git",
              requiredChannels: ["cloud", "git", "agent"],
            }),
          ),
          makeDeps(),
        ),
      ).rejects.toThrow(/step.input.repository must be an object/);
    });
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Payload handling and argv                                                                    */
/* ------------------------------------------------------------------------------------------ */

describe("handleWorkspaceHostRemoteInitializerPayload", () => {
  it("returns exactly one newline-terminated JSON response", async () => {
    const out = await handleWorkspaceHostRemoteInitializerPayload(
      JSON.stringify(request("create-workspace")),
      makeDeps(),
    );
    expect(out.endsWith("\n")).toBe(true);
    expect(out.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(out)).toMatchObject({
      protocolVersion: PROTOCOL,
      status: "succeeded",
    });
  });

  it("reports malformed JSON as a protocol error, not as a crash", async () => {
    await expect(
      handleWorkspaceHostRemoteInitializerPayload(
        '{"protocolVersion":',
        makeDeps(),
      ),
    ).rejects.toThrow(WorkspaceHostRemoteInitializerProtocolError);
    await expect(
      handleWorkspaceHostRemoteInitializerPayload("", makeDeps()),
    ).rejects.toThrow(/request body is not valid JSON/);
  });
});

describe("assertWorkspaceHostRemoteInitializerArgv", () => {
  it("accepts exactly the argv the controller emits", () => {
    expect(() =>
      assertWorkspaceHostRemoteInitializerArgv([
        ...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV,
      ]),
    ).not.toThrow();
  });

  it("carries the protocol version in the argv the two ends agree on", () => {
    expect(WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV).toContain(PROTOCOL);
  });

  it.each([
    ["no argv at all", []],
    ["a truncated argv", ["--protocol-version", PROTOCOL]],
    ["an extra flag", [...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV, "--verbose"]],
    ["a reordered argv", ["--json-stdin", "--protocol-version", PROTOCOL]],
    [
      "a skewed version",
      [
        "--protocol-version",
        "papercusp-gcp-iap-initialization-v1",
        "--json-stdin",
      ],
    ],
  ])("rejects %s", (_label, argv) => {
    expect(() =>
      assertWorkspaceHostRemoteInitializerArgv(argv as string[]),
    ).toThrow(WorkspaceHostRemoteInitializerProtocolError);
  });

  it('says "(none)" rather than an empty tail when argv was empty', () => {
    expect(() => assertWorkspaceHostRemoteInitializerArgv([])).toThrow(
      /got \(none\)/,
    );
  });
});

/* ------------------------------------------------------------------------------------------ */
/* CLI cycle                                                                                    */
/* ------------------------------------------------------------------------------------------ */

async function* streamOf(
  ...chunks: Array<string | Buffer>
): AsyncIterable<Buffer | string> {
  for (const chunk of chunks) yield chunk;
}

function captureIo(
  argv: readonly string[],
  stdin: AsyncIterable<Buffer | string>,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      argv,
      stdin,
      writeStdout: (text: string) => stdout.push(text),
      writeStderr: (text: string) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

describe("runWorkspaceHostRemoteInitializerCli", () => {
  it("writes one response to stdout and exits 0 on the success path", async () => {
    const { io, stdout, stderr } = captureIo(
      [...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV],
      streamOf(JSON.stringify(request("create-workspace"))),
    );
    const code = await runWorkspaceHostRemoteInitializerCli(io, makeDeps());
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      protocolVersion: PROTOCOL,
      stepId: "step-create-workspace",
      status: "succeeded",
    });
  });

  it("reassembles a request split across stdin chunks", async () => {
    const payload = JSON.stringify(request("create-workspace"));
    const { io, stdout } = captureIo(
      [...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV],
      streamOf(Buffer.from(payload.slice(0, 12)), payload.slice(12)),
    );
    expect(await runWorkspaceHostRemoteInitializerCli(io, makeDeps())).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ status: "succeeded" });
  });

  it.each([
    [
      "an argv mismatch",
      ["--json-stdin"],
      JSON.stringify(request("create-workspace")),
      /expects argv/,
    ],
    [
      "malformed JSON on stdin",
      [...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV],
      "{oops",
      /not valid JSON/,
    ],
    [
      "a protocol-version skew",
      [...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV],
      JSON.stringify({ protocolVersion: "v2", step: step("create-workspace") }),
      /unsupported protocol version/,
    ],
    [
      "an unknown step kind",
      [...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV],
      JSON.stringify(request("teleport-workspace")),
      /no handler for step kind/,
    ],
    [
      "a private clone with no channel",
      [...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV],
      JSON.stringify(
        request("clone-repository", {
          repositoryUrl: "https://example.invalid/repo.git",
          visibility: "private",
          destination: "/srv/workspace/repo",
        }),
      ),
      /must name the credential channel/,
    ],
  ])(
    "exits 1 with a clean stdout on %s",
    async (_label, argv, payload, expected) => {
      // stdout must stay empty on every failure: a partial or contradictory envelope there is
      // reported at the controller as a malformed response, hiding the real fault.
      const { io, stdout, stderr } = captureIo(
        argv as string[],
        streamOf(payload),
      );
      expect(await runWorkspaceHostRemoteInitializerCli(io, makeDeps())).toBe(
        1,
      );
      expect(stdout).toEqual([]);
      expect(stderr.join("")).toMatch(expected);
    },
  );

  it("exits 1 when the verify step finds an unready agent", async () => {
    const report = agentReport({ omp: false });
    const agents = {
      ...report.agents,
      omp: {
        ...report.agents.omp!,
        stderrByteCount: 321,
        stderrByteCountTruncated: false,
      },
    };
    const deps = makeDeps({
      host: new RecordingHost({ agents: { ...report, agents } }),
    });
    const { io, stdout, stderr } = captureIo(
      [...WORKSPACE_HOST_REMOTE_INITIALIZER_ARGV],
      streamOf(JSON.stringify(request("verify-initialization"))),
    );
    expect(await runWorkspaceHostRemoteInitializerCli(io, deps)).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain(
      "agent readiness did not pass for: omp (no-verification-proof; stderr-bytes=321)",
    );
  });

  it("prefixes the stderr diagnostic with the error name and ends it with a newline", async () => {
    const { io, stderr } = captureIo([], streamOf("{}"));
    await runWorkspaceHostRemoteInitializerCli(io, makeDeps());
    expect(stderr.join("")).toMatch(
      /^WorkspaceHostRemoteInitializerProtocolError: /,
    );
    expect(stderr.join("").endsWith("\n")).toBe(true);
  });
});

describe("package entry reachability", () => {
  it("exposes the CLI from the package entry, where a bin file can actually reach it", async () => {
    // The bin file that PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT points at lives outside this
    // package, and the `exports` map publishes "." alone — so a deep import of the CLI module is
    // unresolvable. Dropping these names would leave the initializer built but unwireable, which
    // no other test in this file would notice.
    const entry = await import("./index");
    expect(typeof entry.runWorkspaceHostRemoteInitializerCli).toBe("function");
    expect(typeof entry.readAllStdin).toBe("function");
    expect(entry.WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION).toBe(
      PROTOCOL,
    );

    // Positive control for the instrument itself: a name the entry does NOT publish must read as
    // undefined here. Without it, a namespace object that resolved every property to a function
    // would satisfy the assertions above while proving nothing about what is exported.
    expect(
      (entry as Record<string, unknown>)
        .runWorkspaceHostRemoteInitializerCliThatDoesNotExist,
    ).toBeUndefined();
  });
});

describe("readAllStdin", () => {
  it("concatenates string and Buffer chunks in order", async () => {
    expect(await readAllStdin(streamOf('{"a"', Buffer.from(":1}")))).toBe(
      '{"a":1}',
    );
  });

  it("returns an empty string for an empty stream", async () => {
    expect(await readAllStdin(streamOf())).toBe("");
  });

  it("refuses input past its byte bound", async () => {
    await expect(readAllStdin(streamOf("x".repeat(64)), 32)).rejects.toThrow(
      /exceeded the input limit/,
    );
  });

  it("bounds on BYTES, not characters", async () => {
    // A multi-byte character costs more than one byte; a length-based bound would let a payload
    // several times the intended size through.
    await expect(readAllStdin(streamOf("é".repeat(20)), 30)).rejects.toThrow(
      /exceeded the input limit/,
    );
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Canary evidence                                                                              */
/* ------------------------------------------------------------------------------------------ */

function canaryInput(
  overrides: Partial<BuildWorkspaceHostInitializationCanaryEvidenceInput> = {},
): BuildWorkspaceHostInitializationCanaryEvidenceInput {
  const channelLifecycle = Object.fromEntries(
    WORKSPACE_HOST_CREDENTIAL_CHANNELS.map((channel) => [
      channel,
      {
        bound: true,
        rotated: true,
        previousBindingRevoked: true,
        reconnected: true,
      },
    ]),
  ) as BuildWorkspaceHostInitializationCanaryEvidenceInput["channelLifecycle"];
  return {
    runId: "canary-run-1",
    workspaceId: "ws-1",
    hostId: "byoc-canary-01",
    observedAt: NOW,
    repository: { visibility: "private", cloned: true },
    agents: agentReport(),
    channelLifecycle,
    backupRestore: {
      authorizationMaterialExcluded: true,
      credentialReferencesExcluded: true,
      reboundChannels: [...WORKSPACE_HOST_CREDENTIAL_CHANNELS],
    },
    ...overrides,
  };
}

function problemsOf(
  input: BuildWorkspaceHostInitializationCanaryEvidenceInput,
): readonly string[] {
  try {
    buildWorkspaceHostInitializationCanaryEvidence(input);
  } catch (error) {
    if (error instanceof WorkspaceHostInitializationCanaryEvidenceError)
      return error.problems;
    throw error;
  }
  throw new Error("expected canary evidence construction to be refused");
}

describe("buildWorkspaceHostInitializationCanaryEvidence", () => {
  it("builds live evidence when every observation actually passed", () => {
    const evidence =
      buildWorkspaceHostInitializationCanaryEvidence(canaryInput());
    expect(evidence).toMatchObject({
      contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
      kind: "live",
      runId: "canary-run-1",
      repository: { visibility: "private", cloned: true },
      backupRestore: {
        authorizationMaterial: "excluded",
        credentialReferences: "excluded",
      },
    });
    for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
      expect(evidence.channels[channel]).toEqual({
        bound: true,
        rotated: true,
        previousBindingRevoked: true,
        reconnected: true,
      });
      expect(evidence.backupRestore.reboundChannels).toContain(channel);
    }
    for (const agent of WORKSPACE_HOST_CANARY_AGENTS) {
      expect(evidence.agents[agent]).toEqual({
        ready: true,
        verificationKind:
          agent === "omp" ? "local-inference" : "live-inference",
      });
    }
  });

  it("refuses to widen a FALSE observation into the literal true the type demands", () => {
    // The evidence type declares every field as a literal `true`, so the only other way to
    // obtain a value of it is to assert the success you were meant to be proving. This builder
    // is the seam that refuses instead.
    expect(
      problemsOf(
        canaryInput({ repository: { visibility: "private", cloned: false } }),
      ),
    ).toEqual(["private-repository clone was not observed"]);
  });

  it("refuses a public canary repository", () => {
    expect(
      problemsOf(
        canaryInput({ repository: { visibility: "public", cloned: true } }),
      ),
    ).toEqual(["canary repository must be private"]);
  });

  it("names the specific lifecycle transition a channel did not observe", () => {
    const input = canaryInput();
    const problems = problemsOf({
      ...input,
      channelLifecycle: {
        ...input.channelLifecycle,
        git: { ...input.channelLifecycle.git, previousBindingRevoked: false },
      },
    });
    expect(problems).toEqual([
      "git channel did not observe 'previousBindingRevoked'",
    ]);
  });

  it("refuses a channel with no lifecycle evidence at all", () => {
    const input = canaryInput();
    const { agent: _dropped, ...rest } = input.channelLifecycle as Record<
      string,
      unknown
    >;
    const problems = problemsOf({
      ...input,
      channelLifecycle:
        rest as BuildWorkspaceHostInitializationCanaryEvidenceInput["channelLifecycle"],
    });
    expect(problems).toEqual(["no lifecycle evidence for the 'agent' channel"]);
  });

  it("refuses an unready agent and reports its reason and exit status", () => {
    const problems = problemsOf(
      canaryInput({ agents: agentReport({ claude: false }) }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /claude live readiness did not pass \(no-verification-proof, exit 1\)/,
    );
  });

  it("refuses when an agent was never probed", () => {
    const report = agentReport();
    const { codex: _skipped, ...agents } = report.agents as Record<
      string,
      unknown
    >;
    const problems = problemsOf(
      canaryInput({
        agents: {
          ...report,
          agents: agents as WorkspaceHostAgentVerificationReport["agents"],
        },
      }),
    );
    expect(problems).toEqual(["no readiness probe was run for 'codex'"]);
  });

  it.each([
    ["authorizationMaterialExcluded", "backup retained authorization material"],
    ["credentialReferencesExcluded", "backup retained credential references"],
  ])("refuses a backup where %s is false", (flag, expected) => {
    const input = canaryInput();
    const problems = problemsOf({
      ...input,
      backupRestore: { ...input.backupRestore, [flag]: false },
    });
    expect(problems).toEqual([expected]);
  });

  it("refuses a restore that did not rebind every channel", () => {
    const input = canaryInput();
    const problems = problemsOf({
      ...input,
      backupRestore: { ...input.backupRestore, reboundChannels: ["cloud"] },
    });
    expect(problems).toEqual([
      "restore did not rebind the 'git' channel",
      "restore did not rebind the 'agent' channel",
    ]);
  });

  it("refuses a restore that rebound a channel outside the namespace", () => {
    const input = canaryInput();
    const problems = problemsOf({
      ...input,
      backupRestore: {
        ...input.backupRestore,
        reboundChannels: [
          ...WORKSPACE_HOST_CREDENTIAL_CHANNELS,
          "ssh" as WorkspaceHostCredentialChannel,
        ],
      },
    });
    expect(problems).toEqual(["restore rebound an unknown channel 'ssh'"]);
  });

  it("refuses an observedAt that is not a timestamp", () => {
    expect(problemsOf(canaryInput({ observedAt: "last tuesday" }))).toEqual([
      "canary observedAt must be an ISO timestamp",
    ]);
  });

  it("collects EVERY shortfall in one refusal rather than stopping at the first", () => {
    // A builder that threw on the first problem would make a broken canary run take as many
    // round trips to diagnose as it had faults.
    const input = canaryInput();
    const problems = problemsOf({
      ...input,
      repository: { visibility: "public", cloned: false },
      agents: agentReport({ omp: false }),
      observedAt: "nope",
      backupRestore: {
        authorizationMaterialExcluded: false,
        credentialReferencesExcluded: false,
        reboundChannels: [],
      },
    });
    expect(problems.length).toBeGreaterThanOrEqual(8);
    expect(problems).toContain("canary repository must be private");
    expect(problems).toContain("private-repository clone was not observed");
    expect(problems).toContain("backup retained authorization material");
    expect(problems).toContain("canary observedAt must be an ISO timestamp");
  });

  it("reports the joined problem list in the error message", () => {
    let caught: unknown;
    try {
      buildWorkspaceHostInitializationCanaryEvidence(
        canaryInput({ repository: { visibility: "public", cloned: true } }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(
      WorkspaceHostInitializationCanaryEvidenceError,
    );
    expect((caught as Error).message).toMatch(
      /Canary evidence cannot be constructed: canary repository must be private/,
    );
  });
});

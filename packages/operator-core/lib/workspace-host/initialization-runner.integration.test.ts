/**
 * initialization-runner.integration.test.ts — the PRODUCTION ASSEMBLY (P-046 / WI-40474)
 * against REAL Postgres, exercising REAL RLS.
 *
 * Increment 1 proved the replay STORE honours execute-exactly-once in isolation. This file
 * tests the thing that was actually missing: that `runWorkspaceHostInitialization` joins the
 * observability ledger, the contract planner, the durable replay store and a host adapter into
 * one flow — and that the properties survive that composition.
 *
 * The three claims under test are the ones a reviewer should care about:
 *   1. an initialization is RECORDED as a first-class `action:'initialize'` host operation
 *      (which also exercises migration 955's widened CHECK constraint against real PG);
 *   2. every step runs EXACTLY ONCE against the host across the whole composed run; and
 *   3. an interrupted run RESUMES — re-invoking with the same operationId must not re-execute
 *      steps that already succeeded, because those are real remote side effects.
 *
 * `withWorkspace` is mocked to open an appSql transaction that sets the `app.workspace_id` GUC,
 * i.e. the RLS-SUBJECT harness_app role — the canonical pattern from test/_org-test-db.ts. So
 * isolation here is enforced by REAL policies, not by a WHERE clause in the test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';
import type {
  WorkspaceHostAgentVerificationEvidence,
  WorkspaceHostAgentVerificationReport,
  WorkspaceHostCredentialDeliverySet,
  WorkspaceHostInitializationHostOperationResult,
  WorkspaceHostInitializationHostOperations,
  WorkspaceHostInitializationStep,
  WorkspaceHostInitializationSupportedStepKind,
} from '@papercusp/deployment-driver';
import {
  WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
  resolveWorkspaceHostRequestedAgents,
  workspaceHostCredentialReferenceDigest,
} from '@papercusp/deployment-driver';
import type { WorkspaceHostCredentialRefs } from '@papercusp/deployment-driver';
import {
  WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
  workspaceHostAgentAdmissionProbeSpecs,
  type WorkspaceHostAgentCredentialAdmissionEvidence,
  type WorkspaceHostAgentCredentialAdmissionInput,
} from './agent-credential-admission';
import type {
  WorkspaceHostInitializationRunInput,
  WorkspaceHostInitializationRunnerDependencies,
} from './initialization-runner';

const h = vi.hoisted(() => ({ appSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
}));

const { runWorkspaceHostInitialization: runWorkspaceHostInitializationProduction } = await import(
  './initialization-runner'
);
const { createOrgTestDb } = await import('../../test/_org-test-db');

let n = 0;
const freshWs = () => `wh_run_ws_${++n}_${randomBytes(2).toString('hex')}`;

function refs(): WorkspaceHostCredentialRefs {
  return {
    cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' },
    gitCredentialRef: { kind: 'git', ref: 'git-resolver:v1' },
    agentCredentialRef: { kind: 'agent', ref: 'agent-resolver:v1' },
  };
}

function delivery(): WorkspaceHostCredentialDeliverySet {
  return {
    cloud: { kind: 'provider-identity', generation: 1, audience: 'host-1', revocationRef: 'revoke-cloud-1' },
    git: { kind: 'forwarded-agent', generation: 1, audience: 'host-1', revocationRef: 'revoke-git-1' },
    agent: {
      kind: 'short-lived-delegation',
      generation: 1,
      audience: 'host-1',
      revocationRef: 'revoke-agent-1',
      // Must be after `requestedAt` below — the planner validates the delivery window.
      expiresAt: '2026-08-25T18:00:00.000Z',
    },
  };
}

function admissionEvidence(
  input: WorkspaceHostAgentCredentialAdmissionInput,
): WorkspaceHostAgentCredentialAdmissionEvidence {
  const observedAt = '2026-08-25T15:00:01.000Z';
  const agentEvidence = (agent: 'claude' | 'codex' | 'omp'): WorkspaceHostAgentVerificationEvidence => {
    // Admission accepts receipts from its readiness-bearing probes, whose kinds and disclosure
    // differ by agent. Reuse the shipped probe contract instead of copying a fixture allowlist.
    const spec = workspaceHostAgentAdmissionProbeSpecs(agent)[0]!;
    return {
      contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
      agent,
      ready: true,
      verificationKind: spec.verificationKind,
      endpoint: `https://probe.invalid/${agent}`,
      exitStatus: 0,
      observedAt,
      ...(spec.subjectDisclosure === 'redacted' ? { subject: 'authenticated' } : {}),
      proofDigest: `proof-${agent}`,
      subjectDisclosure: spec.subjectDisclosure,
    };
  };
  const verification: WorkspaceHostAgentVerificationReport = {
    contractVersion: WORKSPACE_HOST_AGENT_VERIFICATION_CONTRACT_VERSION,
    observedAt,
    allReady: resolveWorkspaceHostRequestedAgents(input.requestedAgents).length === 3,
    ...(input.requestedAgents !== undefined ? { requestedAgents: input.requestedAgents } : {}),
    agents: Object.fromEntries(resolveWorkspaceHostRequestedAgents(input.requestedAgents).map((agent) => [agent, agentEvidence(agent)])),
  };
  return {
    contractVersion: WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
    sourceKind: 'operator-integration-credentials',
    binding: {
      channel: 'agent',
      family: 'agent-forwarded-reference',
      generation: input.delivery.generation,
      referenceDigest: workspaceHostCredentialReferenceDigest(input.credentialRef.ref),
    },
    observedAt,
    verification: { ...verification, credentialFreeAgents: [], unfundedAgents: [], admissible: true },
  };
}

const DEFAULT_TEST_DEPENDENCIES: Pick<WorkspaceHostInitializationRunnerDependencies, 'verifyAgentCredentialAdmission'> = {
  verifyAgentCredentialAdmission: async (input) => admissionEvidence(input),
};

function runWorkspaceHostInitialization(
  input: WorkspaceHostInitializationRunInput,
  overrides: Partial<WorkspaceHostInitializationRunnerDependencies> = {},
) {
  return runWorkspaceHostInitializationProduction(input, {
    ...DEFAULT_TEST_DEPENDENCIES,
    ...overrides,
  });
}

/**
 * Records every step the host actually saw. `failOn` makes one step throw, which is how the
 * resume test creates a genuine mid-run interruption rather than simulating one.
 */
function recordingAdapter(failOn?: string): WorkspaceHostInitializationHostOperations & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    supportedStepKinds: [
      'create-workspace',
      'clone-repository',
      'pair-workspace',
      'import-workspace',
      'bind-credential',
      'verify-initialization',
    ],
    async execute(step: WorkspaceHostInitializationStep): Promise<WorkspaceHostInitializationHostOperationResult> {
      calls.push(step.id);
      if (failOn && step.id === failOn) {
        throw new Error(`host refused step ${step.id}`);
      }
      return {
        observedAt: '2026-08-25T16:00:00.000Z',
        publicEvidence: { step: step.id },
      };
    },
  };
}

describe('workspace-host initialization runner (real PG + real RLS)', () => {
  let db: OrgTestDb;

  /** Seed the FK chain (connection -> host) the operation and step rows require. */
  async function seedHost(workspaceId: string): Promise<string> {
    const connectionId = `conn_${randomBytes(3).toString('hex')}`;
    const hostId = `host_${randomBytes(3).toString('hex')}`;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections (
        workspace_id, id, target, label, credential_ref
      ) VALUES (${workspaceId}, ${connectionId}, 'gcp', 'test connection', 'cloudCredentialRef:test')
    `;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_hosts (
        workspace_id, id, name, connection_id, target, scope_label, region, size, image,
        disk_gib, network, desired_state, observed_state
      ) VALUES (
        ${workspaceId}, ${hostId}, 'test host', ${connectionId}, 'gcp', 'test-project',
        'us-central1', 'e2-standard-4', 'papercusp-host-v1', 64, 'default', 'running', 'running'
      )
    `;
    return hostId;
  }

  const runInput = (
    workspaceId: string,
    hostId: string,
    operations: WorkspaceHostInitializationHostOperations,
    operationId?: string,
  ) => ({
    workspaceId,
    hostId,
    ...(operationId ? { operationId } : {}),
    requestedAt: '2026-08-25T15:00:00.000Z',
    source: { kind: 'empty' as const },
    credentialRefs: refs(),
    credentialDelivery: delivery(),
    credentialMaterialSource: {
      resolve: async () => {
        throw new Error('the injected admission verifier must not resolve real credential material');
      },
    },
    deliveryCapabilities: { fileTransfer: true },
    operations,
  });

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  it("records the run as an 'initialize' host operation and drives it to succeeded", async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const adapter = recordingAdapter();

    const result = await runWorkspaceHostInitialization(runInput(ws, hostId, adapter));

    // The contract's own tests pin this step set for an 'empty' source; asserting it here is
    // what proves the runner passed a well-formed request through to the real planner.
    expect(result.plan.steps.map((step) => step.id)).toEqual([
      'workspace',
      'bind-cloud',
      'bind-git',
      'bind-agent',
      'verify',
    ]);
    expect(result.receipts).toHaveLength(5);

    const [operation] = await db.adminSql`
      SELECT action, status, percent, request
        FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${result.operationId}
    `;
    // action='initialize' only inserts if migration 955 widened the CHECK constraint.
    expect(operation.action).toBe('initialize');
    expect(operation.status).toBe('succeeded');
    expect(operation.percent).toBe(100);
    // The PLAN is what gets persisted — the artifact the library asserts is secret-isolated.
    expect(operation.request?.steps?.map((s: { id: string }) => s.id)).toEqual([
      'workspace',
      'bind-cloud',
      'bind-git',
      'bind-agent',
      'verify',
    ]);
    expect(operation.request?.credentialAdmissions).toHaveLength(1);
    expect(operation.request?.credentialAdmissions[0]).toMatchObject({
      contractVersion: WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
      binding: {
        channel: 'agent',
        generation: 1,
        referenceDigest: workspaceHostCredentialReferenceDigest(refs().agentCredentialRef!.ref),
      },
      verification: { allReady: true },
    });
    expect(result.credentialAdmission).toEqual(operation.request?.credentialAdmissions[0]);
    expect(result.credentialAdmissions).toEqual(operation.request?.credentialAdmissions);
  });

  it('persists the same explicit agent coverage in admission and the remote verify step', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const requestedAgents = ['claude', 'omp'] as const;
    const seen: WorkspaceHostAgentCredentialAdmissionInput[] = [];
    const result = await runWorkspaceHostInitialization({
      ...runInput(ws, hostId, recordingAdapter()), requestedAgents,
    }, { verifyAgentCredentialAdmission: async (input) => {
      seen.push(input);
      return admissionEvidence(input);
    } });
    expect(seen[0].requestedAgents).toEqual(requestedAgents);
    const [operation] = await db.adminSql`
      SELECT request FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${result.operationId}
    `;
    expect(operation.request.steps.at(-1).input.requestedAgents).toEqual(requestedAgents);
    expect(operation.request.credentialAdmissions[0].verification).toMatchObject({ requestedAgents, allReady: false });
    expect(operation.request.credentialAdmissions[0].verification.agents.codex).toBeUndefined();
  });

  it('enriches a durable transport-discovery row with exact credential admission evidence', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const operationId = `async_${randomBytes(4).toString('hex')}`;
    const { beginWorkspaceHostOperation } = await import('./observability-store');
    await beginWorkspaceHostOperation({
      workspaceId: ws, hostId, operationId, action: 'initialize', status: 'running',
      request: { phase: 'transport-discovery' },
    });
    await runWorkspaceHostInitialization(runInput(ws, hostId, recordingAdapter(), operationId));
    const [operation] = await db.adminSql`
      SELECT status, request FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${operationId}
    `;
    expect(operation.status).toBe('succeeded');
    expect(operation.request.credentialAdmissions).toHaveLength(1);
    expect(operation.request.steps.at(-1).kind).toBe('verify-initialization');
    expect(operation.request).not.toHaveProperty('phase');
  });

  it('rejects failed exact-generation admission before creating an operation row', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const operationId = `op_${randomBytes(4).toString('hex')}`;
    const adapter = recordingAdapter();
    const onPlanned = vi.fn();

    await expect(
      runWorkspaceHostInitialization(
        { ...runInput(ws, hostId, adapter, operationId), onPlanned },
        {
          verifyAgentCredentialAdmission: async () => {
            throw new Error('exact stored generation is not authenticated');
          },
        },
      ),
    ).rejects.toThrow(/exact stored generation is not authenticated/);

    const operations = await db.adminSql`
      SELECT id FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${operationId}
    `;
    expect(operations).toHaveLength(0);
    expect(adapter.calls).toEqual([]);
    expect(onPlanned).not.toHaveBeenCalled();
  });

  it('rejects retired Claude authenticated-account evidence before creating an operation row', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const operationId = `op_${randomBytes(4).toString('hex')}`;
    const adapter = recordingAdapter();
    const onPlanned = vi.fn();

    await expect(
      runWorkspaceHostInitialization(
        { ...runInput(ws, hostId, adapter, operationId), onPlanned },
        {
          verifyAgentCredentialAdmission: async (input) => {
            const evidence = admissionEvidence(input);
            return {
              ...evidence,
              verification: {
                ...evidence.verification,
                agents: {
                  ...evidence.verification.agents,
                  claude: {
                    ...evidence.verification.agents.claude!,
                    verificationKind: 'authenticated-account',
                  },
                },
              },
            };
          },
        },
      ),
    ).rejects.toThrow(/invalid 'claude' verification/);

    const operations = await db.adminSql`
      SELECT id FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${operationId}
    `;
    expect(operations).toHaveLength(0);
    expect(adapter.calls).toEqual([]);
    expect(onPlanned).not.toHaveBeenCalled();
  });

  it('rejects admission evidence for a different generation before creating an operation row', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const operationId = `op_${randomBytes(4).toString('hex')}`;
    const adapter = recordingAdapter();
    const onPlanned = vi.fn();

    await expect(
      runWorkspaceHostInitialization(
        { ...runInput(ws, hostId, adapter, operationId), onPlanned },
        {
          verifyAgentCredentialAdmission: async (input) => {
            const evidence = admissionEvidence(input);
            return {
              ...evidence,
              binding: { ...evidence.binding, generation: evidence.binding.generation + 1 },
            };
          },
        },
      ),
    ).rejects.toThrow(/does not match the requested binding/);

    const operations = await db.adminSql`
      SELECT id FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${operationId}
    `;
    expect(operations).toHaveLength(0);
    expect(adapter.calls).toEqual([]);
    expect(onPlanned).not.toHaveBeenCalled();
  });


  it('census marker: persists receipt content in the controller database and timeline under real RLS', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const marker = 'customer-receipt-census-' + randomBytes(8).toString('hex');
    const adapter = recordingAdapter();
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (step) => ({
      ...(await execute(step)),
      publicEvidence: { step: step.id, directory: '/srv/' + marker },
    });

    const result = await runWorkspaceHostInitialization(runInput(ws, hostId, adapter));
    const receipts = await db.adminSql`
      SELECT public_evidence FROM harness_shared.workspace_host_initialization_steps
      WHERE workspace_id = ${ws} AND host_id = ${hostId} AND status = 'succeeded'
    `;
    expect(receipts).toHaveLength(result.receipts.length);
    expect(receipts.every((row) => row.public_evidence.directory === '/srv/' + marker)).toBe(true);
    const events = await db.adminSql`
      SELECT details FROM harness_shared.workspace_host_events
      WHERE workspace_id = ${ws} AND operation_id = ${result.operationId}
        AND details ? 'publicEvidence'
    `;
    expect(events).toHaveLength(result.receipts.length);
    expect(events.every((row) => row.details.publicEvidence.directory === '/srv/' + marker)).toBe(true);
    // A different tenant's RLS view cannot read these rows. This is a customer/controller
    // DB experiment; it does not establish a deployed vendor's placement or an ingress leak.
    await h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${freshWs()}, true)`;
      expect(await tx`
        SELECT public_evidence FROM harness_shared.workspace_host_initialization_steps
        WHERE host_id = ${hostId}
      `).toEqual([]);
      expect(await tx`
        SELECT details FROM harness_shared.workspace_host_events WHERE operation_id = ${result.operationId}
      `).toEqual([]);
    });
  });

  it('census marker: carries SSH stderr to the operation error while redacting secrets and keeping timeline summaries clear', async () => {
    const { GcpIapWorkspaceHostInitializationOperations } = await import('./gcp-iap-initialization-operations');
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const operationId = 'op_' + randomBytes(6).toString('hex');
    const marker = 'customer-stderr-census-' + randomBytes(8).toString('hex');
    const stdoutMarker = 'private-stdout-census-' + randomBytes(8).toString('hex');
    let commands = 0;
    const adapter = new GcpIapWorkspaceHostInitializationOperations({
      projectId: 'census-test-project', zone: 'us-central1-a', instanceName: 'census-test-host',
      instanceId: '4715512353118305137', remoteEntrypoint: '/opt/papercusp/current/bin/papercusp-workspace-initialize',
      sshUser: 'papercusp-workspace', knownHostsFile: '/census/known_hosts', identityFile: '/census/identity',
    }, {
      async run(command) {
        commands += 1;
        // Actual bootstrap/execute command construction; only transport I/O is synthetic.
        if (!command.stdin) return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 23, stdout: stdoutMarker, stderr: marker + ' Authorization: Bearer census.secret.value' };
      },
    });
    await expect(runWorkspaceHostInitialization(runInput(ws, hostId, adapter, operationId))).rejects.toThrow(marker);
    expect(commands).toBe(2);
    const [operation] = await db.adminSql`
      SELECT status, message, error FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${ws} AND id = ${operationId}
    `;
    expect(operation.status).toBe('failed');
    expect(operation.error.message).toContain(marker);
    expect(operation.error.message).toContain('[REDACTED]');
    expect(JSON.stringify(operation)).not.toContain('census.secret.value');
    expect(JSON.stringify(operation)).not.toContain(stdoutMarker);
    expect(operation.message).not.toContain(marker);
    const events = await db.adminSql`
      SELECT message, details FROM harness_shared.workspace_host_events
      WHERE workspace_id = ${ws} AND operation_id = ${operationId}
    `;
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(marker);
    expect(JSON.stringify(events)).not.toContain(stdoutMarker);
    const steps = await db.adminSql`
      SELECT public_evidence FROM harness_shared.workspace_host_initialization_steps
      WHERE workspace_id = ${ws} AND host_id = ${hostId}
    `;
    expect(steps).toEqual([]);
  });

  it('executes every step exactly once against the host', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const adapter = recordingAdapter();

    await runWorkspaceHostInitialization(runInput(ws, hostId, adapter));

    expect(adapter.calls).toEqual(['workspace', 'bind-cloud', 'bind-git', 'bind-agent', 'verify']);
    expect(new Set(adapter.calls).size).toBe(adapter.calls.length);
  });

  it('appends a timeline event per completed step plus a terminal completion event', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);

    const result = await runWorkspaceHostInitialization(runInput(ws, hostId, recordingAdapter()));

    const events = (await db.adminSql`
      SELECT phase, status FROM harness_shared.workspace_host_events
       WHERE workspace_id = ${ws} AND operation_id = ${result.operationId}
       ORDER BY occurred_at, phase
    `) as unknown as Array<{ phase: string; status: string }>;
    const phases = events.map((row) => row.phase);
    expect(phases).toContain('initialize:create-workspace');
    expect(phases).toContain('initialize:bind-credential');
    expect(phases).toContain('initialize:complete');
    expect(events.some((row) => row.phase === 'initialize:complete' && row.status === 'succeeded')).toBe(true);
  });

  it('RESUMES an interrupted run without re-executing steps that already succeeded', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const operationId = `op_${randomBytes(4).toString('hex')}`;

    // First attempt: the host refuses the third step.
    const failing = recordingAdapter('bind-git');
    await expect(runWorkspaceHostInitialization(runInput(ws, hostId, failing, operationId))).rejects.toThrow(
      /host refused step bind-git/,
    );

    expect(failing.calls).toEqual(['workspace', 'bind-cloud', 'bind-git']);

    const [failed] = await db.adminSql`
      SELECT status FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${operationId}
    `;
    expect(failed.status).toBe('failed');

    // Second attempt, SAME operationId: a fresh adapter, so any call it records is by definition
    // a re-execution against the host. The two already-succeeded steps must not appear.
    const resuming = recordingAdapter();
    const result = await runWorkspaceHostInitialization(runInput(ws, hostId, resuming, operationId));

    expect(resuming.calls).not.toContain('workspace');
    expect(resuming.calls).not.toContain('bind-cloud');
    expect(resuming.calls).toEqual(['bind-git', 'bind-agent', 'verify']);
    expect(result.receipts).toHaveLength(5);

    const [succeeded] = await db.adminSql`
      SELECT status, percent FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${operationId}
    `;
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.percent).toBe(100);
  });

  it('terminalizes a capability-validation failure after the operation row is created', async () => {
    const ws = freshWs();
    const hostId = await seedHost(ws);
    const operationId = `op_${randomBytes(4).toString('hex')}`;
    const invalid: WorkspaceHostInitializationHostOperations = {
      supportedStepKinds: [
        'create-workspace',
        'clone-repository',
        'pair-workspace',
        'import-workspace',
        'bind-credential',
        'verify-initialization',
        'not-a-real-step' as unknown as WorkspaceHostInitializationSupportedStepKind,
      ],
      async execute() {
        throw new Error('the adapter must not execute after capability validation fails');
      },
    };

    await expect(runWorkspaceHostInitialization(runInput(ws, hostId, invalid, operationId))).rejects.toThrow(
      /Unsupported workspace-host initialization step kind/,
    );

    const [operation] = await db.adminSql`
      SELECT status, percent, finished_at
        FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${ws} AND id = ${operationId}
    `;
    expect(operation.status).toBe('failed');
    expect(operation.percent).toBe(0);
    expect(operation.finished_at).not.toBeNull();

    const [event] = await db.adminSql`
      SELECT phase, status, details
        FROM harness_shared.workspace_host_events
       WHERE workspace_id = ${ws} AND operation_id = ${operationId}
       ORDER BY occurred_at, id
    `;
    expect(event).toMatchObject({ phase: 'initialize:failed', status: 'failed' });

    const steps = await db.adminSql`
      SELECT 1
        FROM harness_shared.workspace_host_initialization_steps
       WHERE workspace_id = ${ws} AND host_id = ${hostId}
    `;
    expect(steps).toHaveLength(0);
  });

  it('keeps initialization state isolated between workspaces', async () => {
    const wsA = freshWs();
    const wsB = freshWs();
    const hostA = await seedHost(wsA);
    const hostB = await seedHost(wsB);

    const a = await runWorkspaceHostInitialization(runInput(wsA, hostA, recordingAdapter()));
    await runWorkspaceHostInitialization(runInput(wsB, hostB, recordingAdapter()));

    const crossRead = await db.adminSql`
      SELECT id FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${wsB} AND id = ${a.operationId}
    `;
    expect(crossRead).toHaveLength(0);
  });
});

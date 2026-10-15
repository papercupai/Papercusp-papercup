import { access, readFile } from 'node:fs/promises';

import {
  WorkspaceHostCredentialMaterial,
  WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION,
  WORKSPACE_HOST_AGENT_HOME_MUTABLE_CACHE_BUNDLE_VERSION,
  buildWorkspaceHostCredentialReference,
  encodeWorkspaceHostAgentHomeBundle,
  workspaceHostAgentAllowedVerificationKinds,
  workspaceHostAgentHomePaths,
  workspaceHostCredentialReferenceDigest,
  type WorkspaceHostAgentProbeFailureReason,
  type WorkspaceHostAgentProbeInvocation,
  type WorkspaceHostAgentProbeOutcome,
  type WorkspaceHostAgentProbeRunner,
  type WorkspaceHostAgentVerificationProbeSpec,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
  WorkspaceHostAgentCredentialAdmissionError,
  assertWorkspaceHostAgentCredentialAdmissionEvidence,
  verifyWorkspaceHostAgentCredentialAdmission,
  workspaceHostAgentAdmissionProbeSpecs,
} from './agent-credential-admission';
import type {
  WorkspaceHostCredentialMaterialRequest,
  WorkspaceHostCredentialMaterialSource,
} from './credential-material-source';

const AGENT_REF = buildWorkspaceHostCredentialReference('agent-encrypted-reference', {
  hostId: 'host-1',
  agentSet: 'claude-codex-omp',
});
const DELIVERY = {
  kind: 'encrypted-reference' as const,
  generation: 5,
  audience: 'host-1',
  revocationRef: 'pc-agent-revocation://host-1/claude-codex-omp/5',
};
const NOW = () => new Date('2026-09-07T06:00:00.000Z');

function probe(
  agent: 'claude' | 'codex' | 'omp',
  verificationKind: WorkspaceHostAgentVerificationProbeSpec['verificationKind'],
  overrides: Partial<WorkspaceHostAgentVerificationProbeSpec> = {},
): WorkspaceHostAgentVerificationProbeSpec {
  return {
    agent,
    verificationKind,
    command: `probe-${agent}`,
    args: [],
    endpoint: `https://probe.invalid/${agent}`,
    proofPattern: /^(READY)$/m,
    subjectDisclosure: 'digest',
    ...overrides,
  };
}

/**
 * The SHIPPED kinds (WI-10005806): admission runs claude and codex on live inference, and a present
 * OMP credential on its authenticated-account probe. A fixture that labels every agent
 * authenticated-account produces receipts the shipped validator correctly refuses.
 */
const PROBES = {
  claude: [probe('claude', 'live-inference')],
  codex: [probe('codex', 'live-inference')],
  omp: [probe('omp', 'authenticated-account')],
} satisfies Record<'claude' | 'codex' | 'omp', readonly WorkspaceHostAgentVerificationProbeSpec[]>;

type CodexProbeStatus = 'healthy' | 'revoked' | 'unfunded' | 'malformed' | 'unauthorized';

/**
 * The failure reason the classifier would produce for each simulated state. Only `unfunded` is
 * compatible with an authentic credential; the other three describe the credential itself.
 */
const FAILURE_HINTS: Record<
  Exclude<CodexProbeStatus, 'healthy'>,
  WorkspaceHostAgentProbeFailureReason
> = {
  revoked: 'credential-revoked',
  unfunded: 'provider-usage-limit',
  malformed: 'credential-malformed',
  unauthorized: 'credential-unauthorized',
};

/**
 * Every probe-failure reason that must NOT buy admission — i.e. the whole union except the single
 * quota reason admission deliberately tolerates.
 *
 * EXHAUSTIVE BY CONSTRUCTION: `satisfies Record<Exclude<…, 'provider-usage-limit'>, true>` fails
 * the typecheck if a new `WorkspaceHostAgentProbeFailureReason` is added to the union without being
 * classified here. That is the point — before WI-10001036 this coverage was a hand-written list
 * that had silently fallen three reasons behind the union ('non-zero-exit',
 * 'no-verification-proof', 'probe-error' appeared nowhere in this suite), and a hand-written list
 * would fall behind again the next time the union grows.
 */
const NON_QUOTA_PROBE_FAILURES = Object.keys({
  'non-zero-exit': true,
  'no-verification-proof': true,
  'probe-error': true,
  'credential-revoked': true,
  'credential-malformed': true,
  'credential-unauthorized': true,
} satisfies Record<Exclude<WorkspaceHostAgentProbeFailureReason, 'provider-usage-limit'>, true>) as ReadonlyArray<
  Exclude<WorkspaceHostAgentProbeFailureReason, 'provider-usage-limit'>
>;

function bundle(codex: CodexProbeStatus): Buffer {
  const file = (agent: string, status: string) =>
    Buffer.from(
      JSON.stringify(
        agent === 'codex'
          ? {
              agent,
              status,
              auth_mode: 'chatgpt',
              tokens: {
                access_token: `codex-${status}-access`,
                refresh_token: 'canonical-writer-only',
                id_token: 'codex-identity',
                account_id: 'account-1',
              },
            }
          : agent === 'claude'
            ? {
                agent,
                status,
                // The REAL ~/.claude/.credentials.json shape. A claude file with no
                // claudeAiOauth block fails closed at encode (WI-10001691): neutralization
                // cannot be proven, so the bundle is refused rather than shipping an
                // un-neutralized refresh credential to a cloud VM. The rotating
                // refresh_token here is the writer-only value the projection must blank.
                claudeAiOauth: {
                  accessToken: `claude-${status}-access`,
                  refreshToken: 'canonical-writer-only',
                },
              }
            : { agent, status },
      ),
      'utf8',
    );
  return encodeWorkspaceHostAgentHomeBundle({
    claude: file('claude', 'healthy'),
    codex: file('codex', codex),
    omp: file('omp', 'healthy'),
  });
}

async function healthyEvidence() {
  return verifyWorkspaceHostAgentCredentialAdmission(
    {
      credentialRef: { kind: 'agent', ref: AGENT_REF },
      delivery: DELIVERY,
      materialSource: source(bundle('healthy'), []),
    },
    { runner: new BundleAwareRunner(), probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
  );
}

function source(material: Buffer, seen: WorkspaceHostCredentialMaterialRequest[]): WorkspaceHostCredentialMaterialSource {
  return {
    async resolve(request) {
      seen.push(request);
      return new WorkspaceHostCredentialMaterial(material);
    },
  };
}

class BundleAwareRunner implements WorkspaceHostAgentProbeRunner {
  readonly homes: string[] = [];
  readonly observed: Record<string, string> = {};
  readonly observedBodies: Record<string, Record<string, unknown>> = {};
  readonly environments: Readonly<Record<string, string>>[] = [];

  async run(invocation: WorkspaceHostAgentProbeInvocation): Promise<WorkspaceHostAgentProbeOutcome> {
    const agent = invocation.command.replace(/^probe-/, '') as 'claude' | 'codex' | 'omp';
    const home = invocation.env?.HOME;
    if (!home) throw new Error('probe did not receive an isolated HOME');
    this.homes.push(home);
    this.environments.push(invocation.env ?? {});
    expect(invocation.cwd).toBe(home);
    const body = JSON.parse((await readFile(workspaceHostAgentHomePaths(home)[agent], 'utf8'))) as {
      status: string;
      tokens?: Record<string, unknown>;
    };
    this.observed[agent] = body.status;
    this.observedBodies[agent] = body;
    if (body.status === 'healthy') return { exitCode: 0, stdout: 'READY\n' };
    const failureHint = FAILURE_HINTS[body.status as Exclude<CodexProbeStatus, 'healthy'>];
    if (!failureHint) throw new Error(`unmapped probe status '${body.status}'`);
    return { exitCode: 1, stdout: '', failureHint };
  }
}

describe('workspace-host exact-generation agent credential admission', () => {
  it('admits only requested agents and rejects reuse of scoped evidence for the default all-agent request', async () => {
    const runner = new BundleAwareRunner();
    const input = {
      credentialRef: { kind: 'agent' as const, ref: AGENT_REF },
      delivery: DELIVERY,
      materialSource: source(bundle('revoked'), []),
      requestedAgents: ['claude', 'omp'] as const,
    };
    const evidence = await verifyWorkspaceHostAgentCredentialAdmission(input, {
      runner, probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' },
    });
    expect(runner.observed).toEqual({ claude: 'healthy', omp: 'healthy' });
    expect(evidence.verification).toMatchObject({ requestedAgents: ['claude', 'omp'], allReady: false, admissible: true });
    expect(evidence.verification.agents.codex).toBeUndefined();
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence, input)).not.toThrow();
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence, {
      credentialRef: input.credentialRef, delivery: DELIVERY,
    })).toThrow(/requestedAgents/);
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence({
      ...evidence, verification: { ...evidence.verification, allReady: true },
    })).toThrow(/coverage/);
  });

  it('authenticates the exact stored bundle in an isolated home and returns public binding evidence', async () => {
    const seen: WorkspaceHostCredentialMaterialRequest[] = [];
    const runner = new BundleAwareRunner();
    const evidence = await verifyWorkspaceHostAgentCredentialAdmission(
      {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
        materialSource: source(bundle('healthy'), seen),
      },
      {
        runner,
        probes: PROBES,
        now: NOW,
        environment: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'ambient-must-not-cross' },
      },
    );

    expect(seen).toEqual([
      {
        channel: 'agent',
        credentialRef: AGENT_REF,
        family: 'agent-encrypted-reference',
        generation: 5,
      },
    ]);
    expect(evidence).toMatchObject({
      contractVersion: WORKSPACE_HOST_AGENT_CREDENTIAL_ADMISSION_CONTRACT_VERSION,
      sourceKind: 'operator-integration-credentials',
      binding: {
        channel: 'agent',
        family: 'agent-encrypted-reference',
        generation: 5,
        referenceDigest: workspaceHostCredentialReferenceDigest(AGENT_REF),
      },
      observedAt: '2026-09-07T06:00:00.000Z',
      verification: { allReady: true, credentialFreeAgents: [] },
    });
    expect(runner.observed).toEqual({ claude: 'healthy', codex: 'healthy', omp: 'healthy' });
    expect(runner.observedBodies.codex?.tokens).toMatchObject({
      access_token: 'codex-healthy-access',
      account_id: 'account-1',
    });
    // Neutralized, not deleted: the Codex CLI requires the field to deserialize auth.json at all
    // (P-305 G6 root cause). The rotating secret itself must never reach the probe home.
    expect(runner.observedBodies.codex?.tokens).toHaveProperty('refresh_token', '');
    expect(JSON.stringify(runner.observedBodies.codex)).not.toContain('canonical-writer-only');
    expect(runner.environments.every((env) => !('OPENAI_API_KEY' in env))).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('ambient-must-not-cross');
    await expect(access(runner.homes[0]!)).rejects.toThrow();
  });

  it('rejects legacy mutable-cache bundles before creating a probe home or invoking a runner', async () => {
    const runner = new BundleAwareRunner();
    const encoded = JSON.parse(bundle('healthy').toString('utf8'));
    encoded.contractVersion = WORKSPACE_HOST_AGENT_HOME_MUTABLE_CACHE_BUNDLE_VERSION;
    const codex = JSON.parse(Buffer.from(encoded.files.codex, 'base64').toString('utf8'));
    codex.tokens.refresh_token = 'legacy-refresh';
    encoded.files.codex = Buffer.from(JSON.stringify(codex)).toString('base64');

    await expect(
      verifyWorkspaceHostAgentCredentialAdmission(
        {
          credentialRef: { kind: 'agent', ref: AGENT_REF },
          delivery: DELIVERY,
          materialSource: source(Buffer.from(JSON.stringify(encoded)), []),
        },
        { runner, probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
      ),
    ).rejects.toThrow(/legacy mutable-cache bundles are read\/revoke-only/);
    expect(runner.homes).toEqual([]);
  });

  it('rejects a v3 refresh token before creating a probe home or invoking a runner', async () => {
    const runner = new BundleAwareRunner();
    const encoded = JSON.parse(bundle('healthy').toString('utf8'));
    encoded.contractVersion = WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION;
    const codex = JSON.parse(Buffer.from(encoded.files.codex, 'base64').toString('utf8'));
    codex.tokens.refresh_token = 'must-not-cross';
    encoded.files.codex = Buffer.from(JSON.stringify(codex)).toString('base64');

    await expect(
      verifyWorkspaceHostAgentCredentialAdmission(
        {
          credentialRef: { kind: 'agent', ref: AGENT_REF },
          delivery: DELIVERY,
          materialSource: source(Buffer.from(JSON.stringify(encoded)), []),
        },
        { runner, probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
      ),
    ).rejects.toThrow(/must not contain a refresh token/);
    expect(runner.homes).toEqual([]);
  });

  it('fails closed on revoked stored Codex even when an ambient default is healthy', async () => {
    const runner = new BundleAwareRunner();
    let rejected: WorkspaceHostAgentCredentialAdmissionError | undefined;
    try {
      await verifyWorkspaceHostAgentCredentialAdmission(
        {
          credentialRef: { kind: 'agent', ref: AGENT_REF },
          delivery: DELIVERY,
          materialSource: source(bundle('revoked'), []),
        },
        {
          runner,
          probes: PROBES,
          now: NOW,
          environment: { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'healthy-default' },
        },
      );
    } catch (error) {
      rejected = error as WorkspaceHostAgentCredentialAdmissionError;
    }

    expect(rejected).toBeInstanceOf(WorkspaceHostAgentCredentialAdmissionError);
    expect(rejected?.evidence.verification.agents.codex).toMatchObject({
      ready: false,
      failure: 'credential-revoked',
    });
    expect(runner.observed.codex).toBe('revoked');
    expect(JSON.stringify(rejected)).not.toContain('healthy-default');
    expect(JSON.stringify(rejected)).not.toContain('"status":"revoked"');
    await expect(access(runner.homes[0]!)).rejects.toThrow();
  });

  it('admits an authenticated but out-of-quota agent, records it, and still reports it not ready', async () => {
    const runner = new BundleAwareRunner();
    const evidence = await verifyWorkspaceHostAgentCredentialAdmission(
      {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
        materialSource: source(bundle('unfunded'), []),
      },
      { runner, probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
    );

    // Admission is about authenticity: a quota refusal is only reportable for an identity the
    // provider ACCEPTED, so the credential is proven genuine and must be admitted.
    expect(evidence.verification.admissible).toBe(true);
    expect(evidence.verification.unfundedAgents).toEqual(['codex']);
    expect(evidence.verification.agents.codex).toMatchObject({
      ready: false,
      failure: 'provider-usage-limit',
    });
    // ...but the readiness claim the canary layer reads must NOT be bought by admission.
    expect(evidence.verification.allReady).toBe(false);
    // The admitted receipt must survive the shared validator every consumer calls.
    expect(() =>
      assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence, {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
      }),
    ).not.toThrow();
    expect(JSON.stringify(evidence)).not.toContain('"status":"unfunded"');
  });

  // FALSIFIABILITY. Tolerating the quota case is only safe if every reason that describes the
  // CREDENTIAL still hard-fails. Without these arms the guard above is indistinguishable from
  // "admission accepts any failing probe".
  it.each(['revoked', 'malformed', 'unauthorized'] as const)(
    'still fails admission closed for a %s credential, which quota tolerance must never cover',
    async (status) => {
      const runner = new BundleAwareRunner();
      await expect(
        verifyWorkspaceHostAgentCredentialAdmission(
          {
            credentialRef: { kind: 'agent', ref: AGENT_REF },
            delivery: DELIVERY,
            materialSource: source(bundle(status), []),
          },
          { runner, probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
        ),
      ).rejects.toBeInstanceOf(WorkspaceHostAgentCredentialAdmissionError);
      expect(runner.observed.codex).toBe(status);
    },
  );

  // The quota tolerance is keyed on ONE reason, checked at two independent seams: the producer
  // (the `unfundedAgents` filter) and the receipt validator (`isUnfundedAgentVerificationEvidence`).
  // These arms pin the validator seam — the last line of defence, and the only one reachable for
  // the three SHAPE codes, which no CodexProbeStatus can express so the live-probe arm above
  // cannot reach them. 'probe-error' is the crashed-probe case and occurs in production today.
  async function unfundedReceipt() {
    return await verifyWorkspaceHostAgentCredentialAdmission(
      {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
        materialSource: source(bundle('unfunded'), []),
      },
      { runner: new BundleAwareRunner(), probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
    );
  }

  function relabelCodexFailure(
    evidence: Awaited<ReturnType<typeof unfundedReceipt>>,
    failure: WorkspaceHostAgentProbeFailureReason,
  ) {
    return {
      ...evidence,
      verification: {
        ...evidence.verification,
        agents: {
          ...evidence.verification.agents,
          codex: { ...evidence.verification.agents.codex, failure },
        },
      },
    };
  }

  it.each(NON_QUOTA_PROBE_FAILURES)(
    'rejects a receipt that relabels a %s failure as merely unfunded',
    async (failure) => {
      const forged = relabelCodexFailure(await unfundedReceipt(), failure);
      expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(forged)).toThrow(
        /invalid 'codex' verification/,
      );
    },
  );

  // CALIBRATION for the arms above. They relabel a field on an otherwise-valid receipt, so they
  // would also "pass" if the relabelling itself were what the validator rejected — in which case
  // they would discriminate nothing. Applying the SAME rewrite with the one tolerated reason must
  // therefore be accepted: that is what proves the arms turn on the REASON and not on the forgery.
  it('still accepts the receipt when the same relabelling writes the tolerated quota reason', async () => {
    const evidence = await unfundedReceipt();
    const relabelled = relabelCodexFailure(evidence, 'provider-usage-limit');
    expect(relabelled.verification.agents.codex.failure).toBe('provider-usage-limit');
    expect(() =>
      assertWorkspaceHostAgentCredentialAdmissionEvidence(relabelled, {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
      }),
    ).not.toThrow();
  });

  it('rejects a receipt that claims both an unfunded agent and full readiness', async () => {
    const evidence = await verifyWorkspaceHostAgentCredentialAdmission(
      {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
        materialSource: source(bundle('unfunded'), []),
      },
      { runner: new BundleAwareRunner(), probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
    );

    // allReady is what the readiness layer trusts; an unfunded agent must falsify it, so a receipt
    // asserting both is incoherent and must not be accepted by anything downstream.
    const forged = {
      ...evidence,
      verification: { ...evidence.verification, allReady: true },
    };
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(forged)).toThrow(/invalid agent coverage/);
  });

  it('rejects compound receipts that claim readiness without coherent exact agent coverage', async () => {
    const evidence = await healthyEvidence();
    const { claude, codex, omp } = evidence.verification.agents;
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();
    expect(omp).toBeDefined();

    const invalidReceipts: unknown[] = [
      {
        ...evidence,
        verification: { ...evidence.verification, agents: { claude, omp } },
      },
      {
        ...evidence,
        verification: {
          ...evidence.verification,
          agents: { claude, codex: { ...codex!, agent: 'claude' }, omp },
        },
      },
      {
        ...evidence,
        verification: {
          ...evidence.verification,
          agents: { claude, codex: { ...codex!, proofDigest: '' }, omp },
        },
      },
      {
        ...evidence,
        verification: { ...evidence.verification, credentialFreeAgents: ['claude'] },
      },
      {
        ...evidence,
        verification: { ...evidence.verification, credentialFreeAgents: ['omp'] },
      },
      {
        ...evidence,
        verification: { ...evidence.verification, observedAt: '2026-09-07T06:00:01.000Z' },
      },
      {
        ...evidence,
        binding: { ...evidence.binding, referenceDigest: 'not-a-public-reference-digest' },
      },
    ];

    for (const receipt of invalidReceipts) {
      expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(receipt)).toThrow(
        /workspace-host agent credential admission evidence/,
      );
    }

    expect(() =>
      assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence, {
        credentialRef: { kind: 'agent', ref: `${AGENT_REF}-different` },
        delivery: DELIVERY,
      }),
    ).toThrow(/does not match the requested binding/);
  });

  it('accepts an intentionally credential-free OMP only when it has no contradictory probe evidence', async () => {
    const seen: WorkspaceHostCredentialMaterialRequest[] = [];
    const runner = new BundleAwareRunner();
    const material = encodeWorkspaceHostAgentHomeBundle({
      claude: Buffer.from(
        '{"agent":"claude","status":"healthy","claudeAiOauth":{"accessToken":"claude-healthy-access","refreshToken":"canonical-writer-only"}}',
        'utf8',
      ),
      codex: Buffer.from(
        '{"agent":"codex","status":"healthy","auth_mode":"chatgpt","tokens":{"access_token":"codex-healthy-access","refresh_token":"canonical-writer-only","id_token":"codex-identity"}}',
        'utf8',
      ),
      omp: null,
    });
    const evidence = await verifyWorkspaceHostAgentCredentialAdmission(
      {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
        materialSource: source(material, seen),
      },
      { runner, probes: PROBES, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
    );

    expect(evidence.verification.credentialFreeAgents).toEqual(['omp']);
    expect(evidence.verification.agents.omp).toBeUndefined();
    expect(runner.observed).toEqual({ claude: 'healthy', codex: 'healthy' });
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence)).not.toThrow();
  });
});

describe('admission verification kinds are derived from the probe table (WI-10005806)', () => {
  /** Relabel one agent's verification kind on an otherwise valid, shipped-shape receipt. */
  function relabel(
    evidence: Awaited<ReturnType<typeof healthyEvidence>>,
    agent: 'claude' | 'codex' | 'omp',
    verificationKind: string,
  ) {
    return {
      ...evidence,
      verification: {
        ...evidence.verification,
        agents: { ...evidence.verification.agents, [agent]: { ...evidence.verification.agents[agent], verificationKind } },
      },
    };
  }

  it('the shipped kinds are exactly the readiness-bearing probes admission runs', () => {
    const kinds = (agent: 'claude' | 'codex' | 'omp') =>
      workspaceHostAgentAdmissionProbeSpecs(agent).map((spec) => spec.verificationKind);
    expect(kinds('claude')).toEqual(['live-inference']);
    // codex's `codex login status` probe is satisfiesReadiness:false (WI-10001694): never run here.
    expect(kinds('codex')).toEqual(['live-inference']);
    // A present OMP credential authenticates its bytes; local inference would prove the runtime.
    expect(kinds('omp')).toEqual(['authenticated-account']);
    // Calibration: the readiness derivation itself still offers OMP local inference, so the OMP
    // restriction above is admission's own and not an accident of the table.
    expect([...workspaceHostAgentAllowedVerificationKinds('omp')]).toContain('local-inference');
  });

  it('refuses a persisted claude receipt claiming the retired, forgeable authenticated-account kind', async () => {
    const evidence = await healthyEvidence();
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence)).not.toThrow();
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(relabel(evidence, 'claude', 'authenticated-account'))).toThrow(
      /invalid 'claude' verification/,
    );
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(relabel(evidence, 'omp', 'local-inference'))).toThrow(
      /invalid 'omp' verification/,
    );
  });

  it('moves with the probe table: a table that offers a kind makes admission accept it', async () => {
    const evidence = await healthyEvidence();
    const forged = relabel(evidence, 'claude', 'authenticated-account');
    const table = { ...PROBES, claude: [probe('claude', 'authenticated-account')] };
    expect(() => assertWorkspaceHostAgentCredentialAdmissionEvidence(forged, undefined, table)).not.toThrow();
  });

  it('never runs a satisfiesReadiness:false probe, so it cannot decide admission', async () => {
    const commands: string[] = [];
    const runner: WorkspaceHostAgentProbeRunner = {
      async run(invocation) {
        commands.push(invocation.command);
        // The forgeable status probe would pass; only the readiness probe may decide.
        if (invocation.command === 'codex-login-status') return { exitCode: 0, stdout: 'READY\n' };
        return new BundleAwareRunner().run(invocation);
      },
    };
    const probes = {
      ...PROBES,
      codex: [
        probe('codex', 'authenticated-account', { command: 'codex-login-status', satisfiesReadiness: false }),
        probe('codex', 'live-inference'),
      ],
    };
    const evidence = await verifyWorkspaceHostAgentCredentialAdmission(
      {
        credentialRef: { kind: 'agent', ref: AGENT_REF },
        delivery: DELIVERY,
        materialSource: source(bundle('revoked'), []),
      },
      { runner, probes, now: NOW, environment: { PATH: '/usr/bin:/bin' } },
    ).catch((error: unknown) => error);

    expect(commands).not.toContain('codex-login-status');
    // The revoked codex credential is refused by the readiness probe the status line used to bypass.
    expect(evidence).toBeInstanceOf(WorkspaceHostAgentCredentialAdmissionError);
    const refused = (evidence as WorkspaceHostAgentCredentialAdmissionError).evidence;
    expect(refused.verification.agents.codex).toMatchObject({ verificationKind: 'live-inference', ready: false });
  });
});

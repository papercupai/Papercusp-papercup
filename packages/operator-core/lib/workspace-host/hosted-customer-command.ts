/**
 * Session-bound customer command execution for the owned loop. The controller
 * remains private; only a shell argv and the existing identity wrapper cross
 * pinned SSH. No operator tool handler or model credential crosses that seam.
 * This does not enable a native host or supply ModelPort/billing authority.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { posix } from 'node:path';
import type { AgentSpawnPlan, AgentSpawnTransform } from '@papercusp/papercusp-shared/agent';
import { isHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import { hostedCustomerCommandSpawnTransform } from './hosted-agent-identity';
import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from '../task-manager/enroll-sync';
import { onTaskKillRequested } from '../task-manager/kill-notify';
import type { TaskSpec } from '../task-manager/types';

export interface HostedCustomerCommandRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface HostedCustomerCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
  readonly taskId: string;
  readonly taskEnrolled: boolean;
}

export interface HostedCustomerCommandDependencies {
  readonly resolvePrincipal: (headers: Headers) => Promise<
    { readonly ok: true; readonly principal: HostedPrincipal; readonly monitoringConsent?: unknown } | { readonly ok: false }>;
  /** Authenticated session material, copied once; never tool-call arguments. */
  readonly sessionHeaders: Headers;
  /** The workspace this execution host serves, from trusted host configuration. */
  readonly customerWorkspaceId: string;
  readonly projectDir: string;
  /** Test/host transport seam. Production uses pinned customer loopback SSH. */
  readonly transform?: AgentSpawnTransform;
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 600_000;
const AUTHORIZATION_TIMEOUT_MS = 15_000;
// Positional arguments carry the cwd and command verbatim; neither is pasted
// into this wrapper's shell source. The generic spawn wrapper starts in HOME.
const COMMAND_WRAPPER = 'cd -- "$1" && exec /bin/bash -o pipefail -c "$2"';

export type HostedCustomerSessionBinding = Readonly<Pick<HostedPrincipal,
  'workspaceId' | 'userId' | 'activeOrganizationId' | 'selectedWorkspaceId' | 'sessionId' | 'sessionVersion'>>;

function denied(): Error { return new Error('hosted_customer_execution_denied'); }

function binding(principal: HostedPrincipal): HostedCustomerSessionBinding {
  return Object.freeze({ workspaceId: principal.workspaceId, userId: principal.userId,
    activeOrganizationId: principal.activeOrganizationId, selectedWorkspaceId: principal.selectedWorkspaceId,
    sessionId: principal.sessionId, sessionVersion: principal.sessionVersion });
}

export async function awaitHostedCustomerOperation<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw denied();
  const operation = Promise.resolve().then(() => {
    if (signal.aborted) throw denied();
    return start();
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(denied());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

async function authorize(
  resolve: HostedCustomerCommandDependencies['resolvePrincipal'], headers: Headers, workspaceId: string,
  signal: AbortSignal, expected?: HostedCustomerSessionBinding,
): Promise<HostedCustomerSessionBinding> {
  try {
    const result = await awaitHostedCustomerOperation(() => resolve(new Headers(headers)), signal);
    if (signal.aborted || !result.ok || !isHostedPrincipal(result.principal)
      || !result.principal.permissions.has('workspace:operate')
      || result.principal.selectedWorkspaceId !== workspaceId) throw denied();
    const current = binding(result.principal);
    if (expected && (Object.keys(expected) as Array<keyof HostedCustomerSessionBinding>)
      .some((key) => expected[key] !== current[key])) throw denied();
    return current;
  } catch { throw denied(); }
}

/**
 * Authenticate at binding time and AGAIN before each command. Revocation,
 * demotion, tenant changes and session rotation never inherit an earlier grant.
 * The returned port accepts no account/session/tenant labels or environment.
 */
export async function bindHostedCustomerCommandExecutor(deps: HostedCustomerCommandDependencies): Promise<{
  run(request: HostedCustomerCommandRequest): Promise<HostedCustomerCommandResult>;
  authorize(signal?: AbortSignal): Promise<HostedCustomerSessionBinding>;
}> {
  const headers = new Headers(deps.sessionHeaders);
  const resolve = deps.resolvePrincipal;
  const workspaceId = deps.customerWorkspaceId;
  const projectDir = deps.projectDir;
  if (!workspaceId.trim() || !posix.isAbsolute(projectDir)) throw denied();
  const expected = await authorize(resolve, headers, workspaceId, AbortSignal.timeout(AUTHORIZATION_TIMEOUT_MS));
  const transform = deps.transform ?? hostedCustomerCommandSpawnTransform();
  return {
    authorize(signal) {
      const deadline = AbortSignal.timeout(AUTHORIZATION_TIMEOUT_MS);
      return authorize(resolve, headers, workspaceId,
        signal ? AbortSignal.any([signal, deadline]) : deadline, expected);
    },
    async run(input) {
      const { command, cwd = projectDir, timeoutMs = 120_000, signal: callerSignal } = { ...input };
      if (typeof command !== 'string' || !command.trim() || typeof cwd !== 'string'
        || !posix.isAbsolute(cwd) || !Number.isSafeInteger(timeoutMs)
        || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw denied();
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
      if (signal.aborted) throw denied();
      await authorize(resolve, headers, workspaceId, signal, expected);
      if (signal.aborted) throw denied();
      // An empty env is intentional: no model key, session bearer, DB URL or
      // changed operator environment may enter the customer's shell.
      let plan: AgentSpawnPlan;
      try {
        plan = transform({ backend: 'native-command', command: '/bin/bash',
          args: ['-o', 'pipefail', '-c', COMMAND_WRAPPER, 'customer-command', cwd, command],
          cwd: undefined, env: {}, stagedDirs: [] });
      } catch { throw new Error('hosted_customer_execution_unavailable'); }
      if (signal.aborted) throw denied();
      return execute(plan, signal, expected, deadline);
    },
  };
}

function execute(plan: AgentSpawnPlan, signal: AbortSignal,
  session: HostedCustomerSessionBinding, deadline: AbortSignal): Promise<HostedCustomerCommandResult> {
  return new Promise((resolve, reject) => {
    // Account for the local SSH transport with the existing task ledger. The
    // remote wrapper owns its child group; local enrollment is not a claim of
    // customer cgroup confinement. Wrapping SSH in a service would lose stdin.
    const spec: TaskSpec = { class: 'other', title: 'Hosted customer foreground command',
      argv: [plan.command, ...plan.args], launchedBy: session.userId,
      sessionId: session.sessionId, detail: { customerWorkspaceId: session.selectedWorkspaceId,
        organizationId: session.activeOrganizationId, foreground: true } };
    const task = beginSyncEnrolment(spec, { confine: false });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(plan.command, [...plan.args], { cwd: plan.cwd, env: plan.env,
        stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { reject(new Error('hosted_customer_execution_unavailable')); return; }
    completeSyncEnrolment(task, spec, child.pid ?? null, { workspaceId: session.workspaceId });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      child.kill('SIGTERM');
      // Settle only after close. A command that ignores TERM must not survive
      // the completed foreground call or its output-limit refusal.
      // The identity wrapper gives its detached payload 5s to handle TERM.
      // Killing the wrapper first would orphan a payload holding output pipes.
      if (child.pid) killTimer = setTimeout(() => child.kill('SIGKILL'), 6_500);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { fail('hosted_customer_execution_output_limit'); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', () => fail(signal.aborted
      ? 'hosted_customer_execution_aborted' : 'hosted_customer_execution_unavailable'));
    child.on('close', (exitCode, exitSignal) => {
      signal.removeEventListener('abort', onAbort);
      unsubscribeKill();
      if (killTimer) clearTimeout(killTimer);
      finishSyncEnrolment(task, { state: deadline.aborted ? 'timed_out'
        : failure || signal.aborted || exitSignal ? 'killed' : 'exited', exitCode,
        exitReason: failure?.message ?? exitSignal });
      if (failure || signal.aborted) { reject(failure ?? new Error('hosted_customer_execution_aborted')); return; }
      resolve({ exitCode, signal: exitSignal,
        taskId: task.taskId, taskEnrolled: task.enrolled,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    const unsubscribeKill = onTaskKillRequested((taskId) => {
      if (taskId === task.taskId) fail('hosted_customer_execution_aborted');
    });
    const onAbort = () => fail('hosted_customer_execution_aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    // A missing remote executable can close stdin before the prelude is sent.
    child.stdin.on('error', () => fail('hosted_customer_execution_unavailable'));
    child.stdin.end(plan.stdinPrelude);
  });
}

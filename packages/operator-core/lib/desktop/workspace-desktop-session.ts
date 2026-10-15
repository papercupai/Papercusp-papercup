/** D-363: a lease crosses Unix identities over the pack's group-restricted socket. */
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { FrameDecoder, FrameType, encodeJsonFrame } from '@papercusp/ipc-framing';
import { z } from 'zod';
import type { ProvisionOptions, SandboxDesktop } from '../agent-tools/computer/desktop-provisioner';
import { DesktopXServerExitedError, describeXServerExit } from '../agent-tools/computer/desktop-provisioner-core';
import { kasmvncWebsocketPort } from './x-server-backend';

export const WORKSPACE_DESKTOP_SOCKET = '/run/papercusp-desktop/session.sock';
/**
 * personal-cloud-desktop-2026-10-06 (D-001): the SECOND instance of the D-363 socket
 * worker, running as the customer account instead of the isolated desktop user. A
 * personal (`scope: 'user'`) lease dials only this socket and an agent/pot lease only
 * `WORKSPACE_DESKTOP_SOCKET`, so neither class can land in the other's identity.
 */
export const PERSONAL_DESKTOP_SOCKET = '/run/papercusp-personal-desktop/session.sock';
/** The Unix account a personal desktop must run as — the customer workspace account. */
export const PERSONAL_DESKTOP_ACCOUNT = 'papercusp-workspace';
export const WORKSPACE_DESKTOP_PROTOCOL = 'papercusp-desktop-session-v1';
export const WORKSPACE_DESKTOP_MAX_BYTES = 128 * 1024;

/** A personal desktop was asked for on a host whose pack has no personal worker. */
export class PersonalDesktopUnavailableError extends Error {
  readonly code = 'personal_desktop_unavailable';
  constructor(message = 'this workspace machine has no personal desktop worker (desktop pack not installed or too old)') {
    super(message);
    this.name = 'PersonalDesktopUnavailableError';
  }
}

// Wire callers cannot choose a Unix identity, executable, environment, password path or display.
export const workspaceDesktopOptions = z.object({
  width: z.number().int().min(1).max(7680).optional(),
  height: z.number().int().min(1).max(4320).optional(),
  captureWidth: z.number().int().min(1).max(7680).optional(),
  captureHeight: z.number().int().min(1).max(4320).optional(),
  apps: z.array(z.array(z.string().min(1).max(4096).refine(s => !s.includes('\0'))).min(1).max(16)).max(16).optional(),
}).strict();

export const workspaceDesktopRequest = z.discriminatedUnion('action', [
  z.object({ protocol: z.literal(WORKSPACE_DESKTOP_PROTOCOL), action: z.literal('provision'), options: workspaceDesktopOptions }).strict(),
  z.object({ protocol: z.literal(WORKSPACE_DESKTOP_PROTOCOL), action: z.literal('release') }).strict(),
]);

const credential = z.object({ user: z.string().min(1), secret: z.string().min(1) }).strict();
const desktopReply = z.object({
  protocol: z.literal(WORKSPACE_DESKTOP_PROTOCOL),
  display: z.string().regex(/^:[1-9]\d*$/),
  number: z.number().int().min(110).max(250),
  width: z.number().int().min(1).max(7680),
  height: z.number().int().min(1).max(4320),
  capture: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  gl: z.object({ id: z.enum(['virtualgl', 'native', 'mesa-software', 'none']), tier: z.enum(['hardware', 'software', 'none']), launchPrefix: z.array(z.string()), reason: z.string(), env: z.record(z.string(), z.string()), renderer: z.string().nullable() }).strict(),
  glProbeSandboxed: z.boolean(),
  endpoint: z.object({ host: z.literal('127.0.0.1'), port: z.number().int() }).strict(),
  credentials: z.object({ view: credential, control: credential }).strict(),
  /** The Unix account the worker asserted it runs as — sent by the personal worker (D-001). */
  account: z.string().min(1).max(64).optional(),
}).strict();

export function serializeWorkspaceDesktop(desktop: SandboxDesktop, account?: string): unknown {
  if (desktop.xServer !== 'kasmvnc' || !desktop.credentials || !desktop.endpoint) {
    throw new Error('isolated desktop did not produce an authenticated KasmVNC endpoint');
  }
  return {
    protocol: WORKSPACE_DESKTOP_PROTOCOL,
    display: desktop.display, number: desktop.number, width: desktop.width, height: desktop.height,
    ...(desktop.capture ? { capture: desktop.capture } : {}),
    gl: desktop.gl, glProbeSandboxed: desktop.glProbeSandboxed,
    endpoint: desktop.endpoint,
    credentials: { view: desktop.credentials.view, control: desktop.credentials.control },
    ...(account ? { account } : {}),
  };
}

export function parseWorkspaceDesktop(value: unknown) {
  const result = desktopReply.parse(value);
  if (result.display !== `:${result.number}` || result.endpoint.port !== kasmvncWebsocketPort(result.number)) {
    throw new Error('isolated desktop endpoint does not match its display');
  }
  return result;
}

/**
 * One socket-activated service instance owns one desktop and releases it on EOF/error,
 * or when its X server exits: the lease is only as alive as this socket (WI-10004206).
 */
export async function serveWorkspaceDesktop(
  input: Readable,
  output: Writable,
  provision: (options: z.infer<typeof workspaceDesktopOptions>) => Promise<SandboxDesktop>,
  log: (line: string) => void = (line) => console.warn(`[desktop-session] ${line}`),
  /** The Unix account this worker asserted it runs as; the personal worker reports it (D-001). */
  account?: string,
): Promise<void> {
  let desktop: SandboxDesktop | undefined;
  let ending = false;
  const decoder = new FrameDecoder();
  try {
    for await (const chunk of input) {
      decoder.push(Buffer.from(chunk));
      if (decoder.bufferedBytes > WORKSPACE_DESKTOP_MAX_BYTES) throw new Error('desktop request too large');
      for (const frame of decoder.drain()) {
        if (frame.type !== FrameType.REQUEST || frame.payload.length > WORKSPACE_DESKTOP_MAX_BYTES) {
          throw new Error('invalid desktop request frame');
        }
        const request = workspaceDesktopRequest.parse(JSON.parse(frame.payload.toString('utf8')));
        if (request.action === 'release') return;
        if (desktop) throw new Error('desktop already provisioned');
        const served: SandboxDesktop = desktop = await provision(request.options);
        if (input.destroyed || output.destroyed) return;
        output.write(encodeJsonFrame(FrameType.EVENT_JSON, serializeWorkspaceDesktop(served, account)));
        // A worker that outlives its X server holds the socket open, and the operator then
        // offers a `ready` desktop that nothing serves. End the session instead: the socket
        // closes, the lease reads dead, and the next start provisions a fresh desktop.
        void served.xServerExited?.then((exit) => {
          if (ending) return;
          log(`${describeXServerExit(served.display, exit)}\nending the desktop session`);
          input.destroy(new Error('desktop X server exited'));
        });
      }
    }
    if (decoder.bufferedBytes) throw new Error('incomplete desktop request');
  } catch (error) {
    // Never reflect arbitrary requests, app argv or credentials into the response/log.
    // The X server's own exit is the exception: it names none of them, and without it
    // the journal cannot say why a desktop never came up.
    if (error instanceof DesktopXServerExitedError) log(describeXServerExit(error.display, error.exit));
    if (!output.destroyed) output.write(encodeJsonFrame(FrameType.ERROR, { error: 'desktop_session_failed' }));
  } finally {
    ending = true;
    try { await desktop?.release(); }
    finally { output.end(); }
  }
}

/** The existing lease owns this socket; its closure is also the worker's stop signal. */
export interface WorkspaceDesktopDialDeps {
  /** Open the worker socket at `path` (tests inject a fake; default `net.connect`). */
  connect?: (path: string) => Socket;
  timeoutMs?: number;
  /** Which worker socket to dial — the sandbox worker unless told otherwise. */
  socketPath?: string;
  /**
   * The Unix account the worker MUST report it runs as. Set for the personal worker
   * (D-001): a reply naming any other account — or none — is refused and the socket
   * closed, so a sandbox worker answering on the personal path can never be mistaken
   * for the person's own desktop.
   */
  expectAccount?: string;
}

export async function provisionWorkspaceDesktop(
  options: ProvisionOptions = {},
  deps: WorkspaceDesktopDialDeps = {},
): Promise<SandboxDesktop> {
  const request = workspaceDesktopOptions.parse(options);
  const socketPath = deps.socketPath ?? WORKSPACE_DESKTOP_SOCKET;
  const socket = (deps.connect ?? ((path: string) => connect(path)))(socketPath);
  const decoder = new FrameDecoder();
  const desktop = await new Promise<ReturnType<typeof parseWorkspaceDesktop>>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: ReturnType<typeof parseWorkspaceDesktop>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (error) { socket.destroy(); reject(error); }
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('isolated desktop did not become ready')), deps.timeoutMs ?? 60_000);
    const onData = (data: Buffer) => {
      try {
        decoder.push(data);
        if (decoder.bufferedBytes > WORKSPACE_DESKTOP_MAX_BYTES) throw new Error('desktop reply too large');
        for (const frame of decoder.drain()) {
          if (frame.payload.length > WORKSPACE_DESKTOP_MAX_BYTES) throw new Error('desktop reply too large');
          if (frame.type === FrameType.ERROR) throw new Error('isolated desktop provisioning failed; inspect its service journal');
          if (frame.type !== FrameType.EVENT_JSON) throw new Error('unexpected desktop reply');
          const reply = parseWorkspaceDesktop(JSON.parse(frame.payload.toString('utf8')));
          if (deps.expectAccount !== undefined && reply.account !== deps.expectAccount) {
            throw new Error(
              `desktop worker reported account ${reply.account ?? '(none)'}, expected ${deps.expectAccount}; refusing the desktop`,
            );
          }
          finish(undefined, reply);
        }
      } catch (error) { finish(error as Error); }
    };
    socket.on('data', onData);
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('isolated desktop connection closed before readiness')));
    socket.once('connect', () => socket.write(encodeJsonFrame(FrameType.REQUEST, {
      protocol: WORKSPACE_DESKTOP_PROTOCOL, action: 'provision', options: request,
    })));
  });
  let released = false;
  return {
    ...desktop,
    gl: desktop.gl,
    xServer: 'kasmvnc', taskId: null,
    isAlive: () => !released && !socket.destroyed,
    credentials: { ...desktop.credentials, passwordFile: '', destroy: () => {} },
    appDiagnostics: () => [],
    release: async () => {
      if (released) return;
      released = true;
      if (socket.destroyed) return;
      // EOF is intentional: the worker's finally block tears down before exiting.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('isolated desktop teardown timed out')); }, 10_000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        socket.end(encodeJsonFrame(FrameType.REQUEST, { protocol: WORKSPACE_DESKTOP_PROTOCOL, action: 'release' }));
      });
    },
  };
}

/**
 * A person's own desktop (personal-cloud-desktop-2026-10-06 R-9): dials ONLY the
 * personal worker socket and accepts the desktop only when that worker reports it runs
 * as the customer account. A host without the personal worker refuses with
 * `personal_desktop_unavailable` rather than falling back to any other route — a
 * fallback would put the person's desktop under a different Unix identity.
 */
export async function provisionPersonalDesktop(
  options: ProvisionOptions = {},
  deps: WorkspaceDesktopDialDeps & { exists?: (path: string) => boolean } = {},
): Promise<SandboxDesktop> {
  const socketPath = deps.socketPath ?? PERSONAL_DESKTOP_SOCKET;
  const exists = deps.exists ?? existsSync;
  if (!exists(socketPath)) throw new PersonalDesktopUnavailableError();
  return provisionWorkspaceDesktop(options, {
    ...deps,
    socketPath,
    expectAccount: deps.expectAccount ?? PERSONAL_DESKTOP_ACCOUNT,
  });
}

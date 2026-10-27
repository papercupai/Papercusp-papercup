/**
 * Awaitable terminal transitions for durable managed tasks.
 *
 * The task ledger's first successful terminal UPDATE is the authority. The store
 * invokes this bridge only after that UPDATE returns a row, so competing exit,
 * kill, timeout, and reconciler writers produce one event rather than one per
 * attempted close. Failed delivery retains the ledger's pending marker for the
 * existing reconciler; it never rolls a truthful terminal close back.
 */
import type { TaskState } from './types';

export const TASK_TERMINAL_EVENT_PREFIX = 'task:terminal:';

export interface TaskTerminalEventInput {
  taskId: string;
  workspaceId: string;
  harnessSlug: string | null;
  taskClass: string;
  launchedBy: string;
  state: Extract<TaskState, 'exited' | 'killed' | 'timed_out' | 'stranded' | 'ended_unobserved'>;
  exitCode: number | null;
  exitReason: string | null;
  /** Durable outbox generation; absent only for legacy direct bridge callers. */
  revision?: number;
}

export type TaskTerminalEventEmitter = (event: TaskTerminalEventInput) => boolean | void | Promise<boolean | void>;

export interface TaskTerminalEventDeps {
  emit?: (opts: import('../events/await/engine').EmitAwaitedEventOpts) => Promise<unknown>;
  warn?: (message: string) => void;
}

export function taskTerminalEventKey(taskId: string): string {
  return `${TASK_TERMINAL_EVENT_PREFIX}${taskId}`;
}

export async function emitTaskTerminalEvent(
  event: TaskTerminalEventInput,
  deps: TaskTerminalEventDeps = {},
): Promise<boolean> {
  const payload = {
    taskId: event.taskId,
    state: event.state,
    exitCode: event.exitCode,
    exitReason: event.exitReason,
    taskClass: event.taskClass,
    harness: event.harnessSlug,
    launchedBy: event.launchedBy,
    ...(event.revision == null ? {} : { terminalEventRevision: event.revision }),
  };
  try {
    const emit = deps.emit ?? (await import('../events/await/engine')).emitAwaitedEvent;
    const result = await emit({
      key: taskTerminalEventKey(event.taskId),
      summary: `Managed ${event.taskClass} task ${event.taskId} entered terminal state ${event.state}.`,
      payload,
      source: 'task-manager',
      workspaceId: event.workspaceId,
      ...(event.revision == null ? {} : {
        taskTerminal: { taskId: event.taskId, workspaceId: event.workspaceId, revision: event.revision },
      }),
    });
    return (result as { latchRecorded?: boolean } | null)?.latchRecorded !== false;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/relation .*event_awaits.* does not exist/.test(message)) return false;
    // Import failures need their original frame: the bridge's warning site
    // cannot identify the module whose initialization failed.
    const diagnostic = error instanceof Error ? error.stack || message : message;
    (deps.warn ?? ((value: string) => console.warn(value)))(
      `[task-manager] terminal event failed for ${event.taskId}: ${diagnostic}`,
    );
    return false;
  }
}

/**
 * client-report-ring.ts — recent client errors and log lines for the desktop
 * "Report a problem" dialog (unified-bug-pipeline-and-honest-queue-2026-10-05
 * P-014, D-048 pt 2).
 *
 * In memory and bounded. Nothing here sends anything: the dialog reads the ring
 * when the reporter moves to Review, and the preview shows what it took. Only the
 * reporter's Send posts it.
 *
 * Errors: window 'error', 'unhandledrejection' and console.error.
 * Log lines: console.warn and console.error, one line each, timestamped.
 */
import { pinModuleState } from '@papercusp/module-singleton';

export const CLIENT_REPORT_RING_LIMITS = { errors: 20, logLines: 200, line: 500 } as const;

export interface ClientReportError {
  at: string;
  source: string;
  message: string;
}

const state = pinModuleState('@papercusp/operator-core.client-report-ring', () => ({
  installed: false,
  errors: [] as ClientReportError[],
  logLines: [] as string[],
}));

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function oneLine(parts: unknown[]): string {
  return parts.map(describe).join(' ').replace(/\s+/g, ' ').trim().slice(0, CLIENT_REPORT_RING_LIMITS.line);
}

function pushBounded<T>(list: T[], item: T, cap: number): void {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
}

export function recordClientError(source: string, message: string, at = new Date().toISOString()): void {
  const text = oneLine([message]);
  if (!text) return;
  pushBounded(state.errors, { at, source, message: text }, CLIENT_REPORT_RING_LIMITS.errors);
}

export function recordClientLogLine(level: 'warn' | 'error', parts: unknown[], at = new Date().toISOString()): void {
  const text = oneLine(parts);
  if (!text) return;
  pushBounded(state.logLines, `${at} ${level} ${text}`, CLIENT_REPORT_RING_LIMITS.logLines);
}

export interface ClientReportRingTarget {
  addEventListener: EventTarget['addEventListener'];
  console: Pick<Console, 'warn' | 'error'>;
}

/** Start recording. Idempotent; a no-op outside a browser unless a target is given. */
export function installClientReportRing(target?: ClientReportRingTarget): void {
  if (state.installed) return;
  const t: ClientReportRingTarget | null =
    target ?? (typeof window !== 'undefined' ? { addEventListener: window.addEventListener.bind(window), console: window.console } : null);
  if (!t) return;
  state.installed = true;
  t.addEventListener('error', (e) => {
    const ev = e as ErrorEvent;
    recordClientError('window.error', ev.message || describe(ev.error));
  });
  t.addEventListener('unhandledrejection', (e) => {
    recordClientError('unhandledrejection', describe((e as PromiseRejectionEvent).reason));
  });
  const { warn, error } = t.console;
  t.console.warn = (...args: unknown[]) => {
    recordClientLogLine('warn', args);
    warn.apply(t.console, args);
  };
  t.console.error = (...args: unknown[]) => {
    recordClientLogLine('error', args);
    recordClientError('console.error', oneLine(args));
    error.apply(t.console, args);
  };
}

/** A copy of what the ring holds now. */
export function readClientReportRing(): { errors: ClientReportError[]; logLines: string[] } {
  return { errors: state.errors.slice(), logLines: state.logLines.slice() };
}

/** Test seam. */
export function _resetClientReportRing(): void {
  state.installed = false;
  state.errors.length = 0;
  state.logLines.length = 0;
}

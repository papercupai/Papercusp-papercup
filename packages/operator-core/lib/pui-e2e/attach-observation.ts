import { parseSseStream } from '@papercusp/sse';

/** An HTTP stream header is not a terminal attach outcome. */
export function attachOutcomeForSession(
  diagnostics: Array<{ args: unknown[] }>,
  advSessionId: number,
): Record<string, unknown> | undefined {
  for (const diagnostic of diagnostics) {
    if (diagnostic.args[0] !== 'PUI_OPERATOR_ATTACH_RESULT') continue;
    const value = diagnostic.args[1] as Record<string, unknown> | undefined;
    if (!value || (value.requestedAdvSessionId !== advSessionId && value.advSessionId !== advSessionId)) continue;
    if (value.status === 'ok' || value.status === 'error') return value;
  }
  return undefined;
}

/** Observe the existing launch protocol without consuming the caller's response. */
export async function observeAttachResponse(
  response: Response,
  emit: (body: Record<string, unknown> | undefined, status: number) => void,
): Promise<void> {
  const observed = response.clone();
  if (response.headers.get('content-type')?.includes('application/json')) {
    emit(await observed.json() as Record<string, unknown>, response.status);
    return;
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return;
  for await (const event of parseSseStream(observed.body)) {
    if (event.event !== 'launch-result') continue;
    const terminal = JSON.parse(event.data) as { httpStatus?: number; body?: Record<string, unknown> };
    emit(terminal.body, terminal.httpStatus ?? response.status);
    return;
  }
}

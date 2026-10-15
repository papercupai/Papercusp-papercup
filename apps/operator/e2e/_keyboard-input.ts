import { writeFile } from 'node:fs/promises';

/** Keyboard evidence for the actual URL-backed workspace-name journey.
 * A page-level keyboard call has no locator action timeout. Keep real key
 * events, but stop the journey at the failed character rather than letting
 * its body continue concurrently with global-timeout teardown.
 */
export type KeyboardInputEvidence = {
  character: string;
  expected: string;
  phase: 'press' | 'verify';
  startedAtMs: number;
  durationMs: number;
  outcome: 'passed' | 'failed';
  error?: string;
};

export type KeyboardRendererEvidence =
  | { kind: 'input'; atMs: number; type: string; value: string; key?: string }
  | { kind: 'heartbeat'; atMs: number; gapMs: number }
  | { kind: 'longtask'; atMs: number; startedAtMs: number; durationMs: number };

export type KeyboardDeliveryEvidence = KeyboardRendererEvidence & { receivedAtMs: number };

/** Pair renderer emission with worker receipt without waiting on the binding.
 * The final renderer snapshot alone cannot distinguish a stalled renderer from
 * delayed CDP delivery, and it may be unavailable on the failing run.
 */
export async function recordWorkspaceKeyboardDelivery(
  page: {
    exposeBinding: (name: string,
      callback: (source: unknown, record: KeyboardRendererEvidence) => void) => Promise<unknown>;
    addInitScript: (script: () => void) => Promise<unknown>;
  },
  evidence: KeyboardDeliveryEvidence[],
): Promise<void> {
  await page.exposeBinding('__tutorialKeyboardEvidence', (_source, record) => {
    if (evidence.length < 400) evidence.push({ ...record, receivedAtMs: Date.now() });
  });
  await page.addInitScript(installWorkspaceKeyboardDiagnostics);
}

/** Body-only attachments disappear with list reporters on passing runs.
 * Keep the JSON in the test output directory before attaching its path.
 */
export async function attachWorkspaceKeyboardDiagnostics(
  testInfo: {
    outputPath: (name: string) => string;
    attach: (name: string, options: { path: string; contentType: string }) => Promise<void>;
  },
  data: unknown,
): Promise<void> {
  const path = testInfo.outputPath('workspace-keyboard-input-diagnostics.json');
  await writeFile(path, JSON.stringify(data));
  await testInfo.attach('workspace-keyboard-input-diagnostics', {
    path, contentType: 'application/json',
  });
}

export async function withinInputBudget<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          'KEYBOARD_INPUT_TIMEOUT ' + description + ' after ' + timeoutMs + 'ms',
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function typeWorkspaceNameWithKeyboard(
  input: { press: (key: string, options: { delay: number; timeout: number }) => Promise<void> },
  text: string,
  verify: (expected: string) => Promise<void>,
  evidence: KeyboardInputEvidence[],
  timeoutMs = 10_000,
): Promise<void> {
  let entered = '';
  for (const character of text) {
    entered += character;
    for (const phase of ['press', 'verify'] as const) {
      const startedAtMs = Date.now();
      const started = performance.now();
      try {
        await withinInputBudget(
          () => phase === 'press'
            ? input.press(character === ' ' ? 'Space' : character, { delay: 20, timeout: timeoutMs })
            : verify(entered),
          timeoutMs,
          phase + ' workspace-name character ' + JSON.stringify(character),
        );
        evidence.push({ character, expected: entered, phase, startedAtMs,
          durationMs: performance.now() - started, outcome: 'passed' });
      } catch (error) {
        evidence.push({ character, expected: entered, phase, startedAtMs,
          durationMs: performance.now() - started, outcome: 'failed',
          error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
  }
}

/** Runs as a Playwright init script; no layout reads or application changes.
 * Only the fixture workspace-name field is recorded, never credential fields.
 */
export function installWorkspaceKeyboardDiagnostics(): void {
  let emitted = 0;
  const emit = (record: KeyboardRendererEvidence) => {
    const receive = (window as unknown as {
      __tutorialKeyboardEvidence?: (record: KeyboardRendererEvidence) => Promise<unknown>;
    }).__tutorialKeyboardEvidence;
    if (typeof receive !== 'function' || emitted >= 400) return;
    emitted += 1;
    // Diagnostics must never change input behavior or surface binding failures.
    try { void Promise.resolve(receive(record)).catch(() => {}); } catch {}
  };
  const diagnostics = {
    timeOrigin: performance.timeOrigin,
    longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    inputs: [] as Array<{ type: string; atMs: number; value: string; key?: string }>,
    longTasks: [] as Array<{ atMs: number; durationMs: number }>,
    heartbeatGaps: [] as Array<{ atMs: number; gapMs: number }>,
  };
  Object.assign(window, { __tutorialKeyboardDiagnostics: diagnostics });
  for (const type of ['keydown', 'beforeinput', 'input', 'keyup']) {
    document.addEventListener(type, event => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)
        || target.getAttribute('aria-label') !== 'Workspace name') return;
      if (diagnostics.inputs.length >= 100) return;
      const input = { type, atMs: Date.now(), value: target.value,
        ...(event instanceof KeyboardEvent ? { key: event.key } : {}) };
      diagnostics.inputs.push(input);
      emit({ kind: 'input', ...input });
    }, true);
  }
  if (diagnostics.longTaskSupported) {
    new PerformanceObserver(entries => {
      for (const entry of entries.getEntries()) {
        if (diagnostics.longTasks.length >= 100) continue;
        const startedAtMs = performance.timeOrigin + entry.startTime;
        diagnostics.longTasks.push({ atMs: startedAtMs, durationMs: entry.duration });
        emit({ kind: 'longtask', atMs: Date.now(), startedAtMs, durationMs: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  }
  let previous = performance.now();
  let lastEmission = previous;
  // timer-classification: must-sample — in-page main-thread stall detector (heartbeat gaps); no event reports a stalled event loop
  setInterval(() => {
    const now = performance.now();
    if (now - previous > 1000 && diagnostics.heartbeatGaps.length < 100) {
      diagnostics.heartbeatGaps.push({ atMs: Date.now(), gapMs: now - previous });
    }
    // One message per second bounds transport overhead; do not poll the page
    // from the worker, which would add a competing CDP command to the stall.
    if (now - lastEmission >= 1000) {
      emit({ kind: 'heartbeat', atMs: Date.now(), gapMs: now - previous });
      lastEmission = now;
    }
    previous = now;
  }, 250);
}

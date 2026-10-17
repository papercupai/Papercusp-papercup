/** macOS window control through public Accessibility/CoreGraphics APIs via JXA.
 * Arguments travel as argv, never interpolated into executable script text.
 * No private Spaces API or synthetic keyboard shortcut is used. Permission
 * denial and an off-Space window that the OS refuses to reveal fail closed.
 */
type CommandResult = { status: number | null; stdout: string };
type Runner = (command: string, args: string[]) => Promise<CommandResult> | CommandResult;
type MacWindow = { pid: number; title: string };

async function run(command: string, args: string[]): Promise<CommandResult> {
  const { execFileResult } = await import('./sync-exec-replay');
  return execFileResult(command, args, { timeout: 5_000 });
}

export const MAC_WINDOW_SCRIPT = `
ObjC.import('CoreGraphics');
if (typeof ObjC.bindFunction === 'function') {
  ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['uint32_t', 'uint32_t']]);
}
function run(argv) {
  const request = JSON.parse(argv[0]);
  const se = Application('System Events');
  if (!se.uiElementsEnabled()) throw new Error('Accessibility permission is required');
  const matches = [];
  const processes = se.applicationProcesses();
  for (let i = 0; i < processes.length; i++) {
    const p = processes[i];
    const pid = p.unixId();
    if (request.pid && pid !== request.pid) continue;
    const windows = p.windows();
    for (let j = 0; j < windows.length; j++) {
      const w = windows[j];
      const title = w.name();
      if (request.title !== undefined ? title !== request.title : request.fragment && title.indexOf(request.fragment) < 0) continue;
      matches.push({pid: pid, title: title, process: p});
    }
  }
  // Refuse ambiguous title/pid matches instead of activating an unrelated tab.
  if (matches.length !== 1) return JSON.stringify(null);
  const match = matches[0];
  if (request.action !== 'focus') return JSON.stringify({pid: match.pid, title: match.title});
  // AX index specifiers follow window order, which restoration/activation changes.
  // The uniqueness guard above makes an exact-name specifier safe to keep instead.
  const process = se.applicationProcesses.whose({unixId: match.pid})()[0];
  if (!process) return JSON.stringify({focused: false});
  const w = process.windows.byName(match.title);
  try { w.attributes.byName('AXMinimized').value = false; } catch (_) {}
  process.frontmost = true;
  // Space changes and AXRaise settle asynchronously. Observe convergence,
  // including on-screen membership, instead of inferring it from AX focus.
  let raised = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      // A restored window can be temporarily absent from AX until it settles.
      if (!raised) { w.actions.byName('AXRaise').perform(); raised = true; }
      const front = se.applicationProcesses.whose({frontmost: true})();
      const focused = process.attributes.byName('AXFocusedWindow').value();
      const onScreen = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0)) || [];
      const visible = onScreen.some(function(info) {
        return info.kCGWindowOwnerPID === match.pid && info.kCGWindowName === match.title && info.kCGWindowLayer === 0;
      });
      if (front.length === 1 && front[0].unixId() === match.pid && focused.name() === match.title && visible) return JSON.stringify({focused: true});
    } catch (_) {}
    delay(0.05);
  }
  return JSON.stringify({focused: false});
}`;

export async function resolveMacWindow(query: { pid?: number; fragment?: string }, runner: Runner = run): Promise<string | null> {
  try {
    const result = await runner('osascript', ['-l', 'JavaScript', '-e', MAC_WINDOW_SCRIPT, JSON.stringify(query)]);
    if (result.status !== 0) return null;
    const window = JSON.parse(result.stdout) as MacWindow | null;
    if (!window || !Number.isInteger(window.pid) || window.pid <= 0 || typeof window.title !== 'string' || !window.title) return null;
    return `macos:${Buffer.from(JSON.stringify(window)).toString('base64url')}`;
  } catch { return null; }
}

export async function focusMacWindow(windowId: string, runner: Runner = run): Promise<boolean> {
  try {
    if (!windowId.startsWith('macos:')) return false;
    const window = JSON.parse(Buffer.from(windowId.slice(6), 'base64url').toString('utf8')) as MacWindow;
    if (!Number.isInteger(window.pid) || window.pid <= 0 || typeof window.title !== 'string' || !window.title) return false;
    const result = await runner('osascript', ['-l', 'JavaScript', '-e', MAC_WINDOW_SCRIPT, JSON.stringify({ ...window, action: 'focus' })]);
    return result.status === 0 && JSON.parse(result.stdout)?.focused === true;
  } catch { return false; }
}

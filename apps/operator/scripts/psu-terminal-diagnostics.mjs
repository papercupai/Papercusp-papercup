import { spawn } from 'node:child_process';

/** Terminal identity is a hint, not proof of a freeze or shared process. */
export function terminalSetup(env = process.env) {
  const vte = Boolean(env.VTE_VERSION || env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE);
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  return {
    family: vte ? 'GNOME/VTE' : String(env.TERM_PROGRAM || env.COLORTERM || env.TERM || 'unknown'),
    vte,
    remote,
    multiplexed: Boolean(env.TMUX || env.ZELLIJ || env.STY),
  };
}

/**
 * Read the current terminal's flags without changing them or requiring an operator.
 * @param {{ platform?: string, interactive?: boolean, spawnCommand?: Function }} [options]
 * @returns {Promise<string | null>}
 */
export async function readTerminalFlags({
  platform = process.platform, interactive = Boolean(process.stdin.isTTY),
  spawnCommand = spawn,
} = {}) {
  if (platform === 'win32' || !interactive) return null;
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    let child;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawnCommand('stty', ['-a'], { stdio: ['inherit', 'pipe', 'ignore'] });
      timer = setTimeout(() => { child.kill(); finish(null); }, 750);
      child.stdout?.on('data', (data) => {
        text += data.toString();
        if (text.length > 8192) { child.kill(); finish(null); }
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(code === 0 ? text : null));
    } catch { finish(null); }
  });
}

/**
 * An unreadable flag set stays unknown; '-ixon' must not match 'ixon'.
 * @param {string | null} flags
 */
export function softwareFlowControl(flags) {
  if (typeof flags !== 'string') return null;
  const tokens = flags.split(/[\s;]+/);
  if (tokens.includes('-ixon')) return false;
  if (tokens.includes('ixon')) return true;
  return null;
}

/** @param {{ env?: Record<string, string | undefined>, flags?: string | null, interactive?: boolean }} [options] */
export function terminalGuidance({ env = process.env, flags = null, interactive = Boolean(process.stdin.isTTY) } = {}) {
  const setup = terminalSetup(env);
  const flow = softwareFlowControl(flags);
  const lines = [
    'psu terminal check (local, read-only)',
    `Terminal hint: ${setup.family}${setup.remote ? ' over SSH (local renderer is unknown)' : ''}${setup.multiplexed ? ' inside a multiplexer' : ''}.`,
    `Software flow control: ${flow === true ? 'enabled' : flow === false ? 'disabled' : 'not measured'}.`,
    'This check reports setup risks; it does not prove why a terminal froze.',
    '',
  ];
  if (flow === true) lines.push(
    'If output stops after Ctrl-S but the window still moves/repaints, press Ctrl-Q.',
    'To prevent accidental output suspension in this shell, run: stty -ixon',
    'If desired, put stty -ixon in your interactive shell configuration; it changes Ctrl-S/Ctrl-Q handling.',
    '',
  );
  if (setup.vte) lines.push(
    'GNOME Terminal can share one renderer across windows. If that renderer stalls, several windows can stop repainting and accepting input together.',
    'For independent agent windows, open a process-per-window terminal: alacritty -e psu, kitty -- psu, or xterm -e psu (install one first).',
    'Keep your preferred terminal if it works for you; an independent window limits the effect of a renderer stall.',
    '',
  );
  lines.push(
    'For long sessions, set a finite scrollback limit in terminal preferences (for example 10,000 lines) and keep the terminal and psu updated.',
    'Run unattended sessions with psu --headless --no-picker --agent=codex --harness=<your-harness> --no-plan, using your usual backend and workspace options.',
    'If the entire terminal GUI freezes, use a separate terminal to inspect the renderer. Save work before closing it; restarting a shared renderer can close every window it owns.',
    'Measure renderer stalls and active paging before changing RAM/swap or resource limits; high load or allocated swap alone does not establish a cause.',
  );
  if (!interactive) lines.push('No interactive stdin is attached, so terminal flags could not be read. Run this check from the affected shell.');
  return lines.join('\n') + '\n';
}

/** Brief targeted notice, once per launcher invocation, before any agent draws. */
export function terminalStartupNotice({ env = process.env, interactive = Boolean(process.stdout.isTTY), headless = false } = {}) {
  if (!interactive || headless || !terminalSetup(env).vte) return null;
  return 'psu: GNOME/VTE terminal detected. If typing or repainting freezes, run psu --terminal-check for setup checks and independent-window options.\n';
}

export async function runTerminalCheck({ env = process.env, interactive = Boolean(process.stdin.isTTY), readFlags = readTerminalFlags } = {}) {
  const flags = await readFlags({ interactive });
  return terminalGuidance({ env, flags, interactive });
}
